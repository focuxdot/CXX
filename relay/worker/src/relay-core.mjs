// Shared relay core for the public self-hosted Worker and the private official Worker.
// This file intentionally contains only zero-knowledge forwarding behavior. Private
// stats/notification hooks live under internal/ and are injected by the official entrypoint.

const PATH_RE = /^\/v1\/(daemon|client)\/([A-Za-z0-9_-]{8,64})$/;

export function createRelayWorker({ serviceLabel = "cxx relay", handleRequest = null } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (handleRequest) {
        const response = await handleRequest(request, env, ctx, url);
        if (response) return response;
      }
      const match = PATH_RE.exec(url.pathname);
      if (!match) {
        return new Response(`${serviceLabel} ok\n`, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const [, , daemonId] = match;
      const stub = env.ROOM.get(env.ROOM.idFromName(daemonId));
      return stub.fetch(request); // preserve Upgrade semantics; the DO parses role from URL
    },
  };
}

export class BaseRelayRoom {
  #state;
  #env;
  #hooks;

  constructor(state, env, { hooks = {} } = {}) {
    this.#state = state;
    this.#env = env;
    this.#hooks = hooks;
    // hb is answered at the edge without waking the DO. The sent string must match exactly.
    this.#state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'),
    );
  }

  async fetch(request) {
    const parsed = PATH_RE.exec(new URL(request.url).pathname);
    const role = parsed?.[1];
    const daemonId = parsed?.[2];
    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = [pair[0], pair[1]];

    if (role === "daemon") {
      // 同一个 daemonId 对应同一个 Durable Object，正常情况下绝不应有两条 daemon
      // 长连接。过去的“新连接顶掉旧连接”会让重复启动的本地 daemon 互相踢下线：
      // A 重连→踢 B，B 的退避重连→踢 A，永远循环并把 daemon_open 统计刷爆。
      // 保留已在线的一端，拒绝后来者；已有连接真正关闭后，重试者会自然接管。
      if (this.#state.getWebSockets("daemon").some((socket) => socket.readyState === 1)) {
        try {
          // 仍按 hibernatable WebSocket 接受后再关闭，确保运行时完成关闭握手；该标签
          // 不会被 client/daemon 查询命中，也没有 attachment，故不会写入统计。
          this.#state.acceptWebSocket(serverEnd, ["rejected-daemon"]);
          serverEnd.close(1008, "daemon already connected");
        } catch {
          // Closing is best-effort; never affect the active daemon.
        }
        return new Response(null, { status: 101, webSocket: clientEnd });
      }
      this.#state.acceptWebSocket(serverEnd, ["daemon"]);
      const meta = {
        app: new URL(request.url).searchParams.get("app") || "",
        os: new URL(request.url).searchParams.get("os") || "",
        country: request.headers.get("cf-ipcountry") || "",
      };
      serverEnd.serializeAttachment({ daemonId, openedAt: Date.now(), meta });
      const clientCount = this.#state.getWebSockets("client").length;
      this.#runHook("daemonOpen", {
        daemonId,
        clientCount,
        meta,
      });

      // Daemon connection epoch: each daemon reconnect increments it and broadcasts it
      // with online status. Replacement does not emit an offline edge, so clients use
      // epoch changes to force a new handshake and re-auth.
      const epoch = ((await this.#state.storage.get("daemonEpoch")) ?? 0) + 1;
      await this.#state.storage.put("daemonEpoch", epoch);
      this.#broadcastToClients({ t: "status", online: true, epoch });

      for (const client of this.#state.getWebSockets("client")) {
        const cid = client.deserializeAttachment()?.cid;
        if (cid) serverEnd.send(JSON.stringify({ t: "open", cid }));
      }
    } else {
      // 64-bit random cid: it is the daemon-side routing key. Collision means client
      // frames can cross-route, even though E2E auth would drop undecipherable frames.
      const cid = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const daemonMeta = this.#daemon()?.deserializeAttachment()?.meta ?? {};
      this.#state.acceptWebSocket(serverEnd, ["client", `cid:${cid}`]);
      serverEnd.serializeAttachment({
        cid,
        daemonId,
        meta: daemonMeta,
        openedAt: Date.now(),
        up: 0,
        down: 0,
        upB: 0,
        downB: 0,
      });
      const online = this.#daemon() !== null;
      const lastSeen = online ? null : ((await this.#state.storage.get("lastSeen")) ?? null);
      const epoch = online ? ((await this.#state.storage.get("daemonEpoch")) ?? null) : null;
      this.#runHook("clientOpen", {
        daemonId,
        cid,
        clientCount: this.#state.getWebSockets("client").length,
        meta: daemonMeta,
      });
      serverEnd.send(JSON.stringify({ t: "status", online, lastSeen, ...(epoch != null ? { epoch } : {}) }));
      this.#safeSend(this.#daemon(), JSON.stringify({ t: "open", cid }));
    }
    return new Response(null, { status: 101, webSocket: clientEnd });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 256 * 1024) {
      ws.close(1009, "frame too large");
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      this.#fromDaemon(ws, frame, raw.length);
    } else {
      this.#fromClient(ws, frame, raw.length);
    }
  }

  async webSocketClose(ws) {
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      const others = this.#state.getWebSockets("daemon").filter((s) => s !== ws);
      if (others.length === 0) {
        const lastSeen = Date.now();
        await this.#state.storage.put("lastSeen", lastSeen);
        this.#broadcastToClients({ t: "status", online: false, lastSeen });
      }
      const att = ws.deserializeAttachment();
      this.#runHook("daemonClose", {
        daemonId: att?.daemonId,
        durationSec: secondsSince(att?.openedAt),
        meta: att?.meta,
      });
      return;
    }
    const att = ws.deserializeAttachment();
    if (att?.cid) this.#safeSend(this.#daemon(), JSON.stringify({ t: "close", cid: att.cid }));
    const remaining = this.#state.getWebSockets("client").filter((s) => s !== ws).length;
    this.#runHook("clientClose", {
      daemonId: att?.daemonId,
      cid: att?.cid,
      durationSec: secondsSince(att?.openedAt),
      remaining,
      up: att?.up ?? 0,
      down: att?.down ?? 0,
      upB: att?.upB ?? 0,
      downB: att?.downB ?? 0,
      meta: att?.meta,
    });
  }

  webSocketError(ws) {
    this.#state.waitUntil(Promise.resolve(this.webSocketClose(ws)).catch(() => {}));
  }

  #fromDaemon(ws, frame, size = 0) {
    if (frame.t === "hb") {
      this.#safeSend(ws, JSON.stringify({ t: "hb" }));
      return;
    }
    if (typeof frame.cid !== "string") return;
    const client = this.#clientByCid(frame.cid);
    if (!client) return;
    if (frame.t === "msg") {
      const att = client.deserializeAttachment();
      if (att) {
        att.down = (att.down ?? 0) + 1;
        att.downB = (att.downB ?? 0) + size;
        client.serializeAttachment(att);
      }
      this.#safeSend(client, JSON.stringify({ t: "msg", data: frame.data }));
    } else if (frame.t === "close") {
      try {
        client.close(1000, "closed by daemon");
      } catch {
        // stale socket
      }
    }
  }

  #fromClient(ws, frame, size = 0) {
    if (frame.t === "hb") {
      this.#safeSend(ws, '{"t":"hb"}');
      return;
    }
    if (frame.t !== "msg") return;
    const att = ws.deserializeAttachment();
    if (!att?.cid) return;
    att.up = (att.up ?? 0) + 1;
    att.upB = (att.upB ?? 0) + size;
    ws.serializeAttachment(att);
    this.#safeSend(this.#daemon(), JSON.stringify({ t: "msg", cid: att.cid, data: frame.data }));
  }

  #daemon() {
    const sockets = this.#state
      .getWebSockets("daemon")
      .filter((s) => s.readyState === 1);
    return sockets.length > 0 ? sockets[sockets.length - 1] : null;
  }

  #safeSend(ws, text) {
    if (!ws) return;
    try {
      ws.send(text);
    } catch {
      // stale socket
    }
  }

  #clientByCid(cid) {
    const sockets = this.#state.getWebSockets(`cid:${cid}`);
    return sockets.length > 0 ? sockets[0] : null;
  }

  #broadcastToClients(frame) {
    const text = JSON.stringify(frame);
    for (const ws of this.#state.getWebSockets("client")) {
      try {
        ws.send(text);
      } catch {
        // stale socket
      }
    }
  }

  #runHook(name, payload) {
    const hook = this.#hooks?.[name];
    if (!hook) return;
    try {
      const result = hook({
        ...payload,
        env: this.#env,
        storage: this.#state.storage,
      });
      if (typeof result?.then === "function") {
        this.#state.waitUntil(Promise.resolve(result).catch(() => {}));
      }
    } catch {
      // Observability hooks must never affect forwarding.
    }
  }
}

function secondsSince(openedAt) {
  if (!openedAt) return 0;
  return Math.max(0, (Date.now() - openedAt) / 1000);
}
