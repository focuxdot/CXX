// Shared relay core for the public self-hosted Worker and the private official Worker.
// This file intentionally contains only zero-knowledge forwarding behavior. Private
// stats/notification hooks live under internal/ and are injected by the official entrypoint.

import { daemonConnectionAction, daemonConnectionDecision, normalizeDaemonInstanceId } from "../../owner.mjs";

export { daemonConnectionAction, daemonConnectionDecision } from "../../owner.mjs";

const PATH_RE = /^\/v1\/(daemon|client)\/([A-Za-z0-9_-]{8,64})$/;

function cleanMeta(value, max = 64) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

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
    const url = new URL(request.url);
    const parsed = PATH_RE.exec(url.pathname);
    const role = parsed?.[1];
    const daemonId = parsed?.[2];
    let existingDaemons = [];
    let daemonConflictAction = "replace";
    let daemonMeta = null;

    if (role === "daemon") {
      const incomingInstanceId = normalizeDaemonInstanceId(url.searchParams.get("inst"));
      daemonMeta = {
        app: cleanMeta(url.searchParams.get("app"), 40),
        os: cleanMeta(url.searchParams.get("os"), 24),
        country: cleanMeta(request.headers.get("cf-ipcountry"), 8),
        version: cleanMeta(url.searchParams.get("ver"), 32),
        instanceId: incomingInstanceId,
      };
      existingDaemons = this.#state
        .getWebSockets("daemon")
        .filter((socket) => socket.readyState === 1);
      for (const old of existingDaemons) {
        const att = old.deserializeAttachment?.() ?? {};
        let lastHeartbeatAt = null;
        try {
          lastHeartbeatAt = this.#state.getWebSocketAutoResponseTimestamp(old);
        } catch {
          // 较旧的本地 Workers runtime 可能还没有该 API；openedAt 宽限仍可避免刚连就互踢。
        }
        const action = daemonConnectionAction({
          incomingInstanceId,
          existingInstanceId: att.instanceId ?? att.meta?.instanceId ?? "",
          lastHeartbeatAt,
          openedAt: att.openedAt,
        });
        if (action !== "replace") {
          daemonConflictAction = action;
          break;
        }
      }
      if (daemonConflictAction === "reject-http") {
        this.#runHook("daemonRejected", {
          daemonId,
          meta: daemonMeta,
          reason: "legacy_owner_conflict",
        });
        return new Response(null, { status: 409 });
      }
    }

    // legacy 冲突已在上方返回；只有真正需要 WS 的路径才构造 pair。
    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = [pair[0], pair[1]];

    if (role === "daemon") {
      if (daemonConflictAction === "reject-websocket") {
        try {
          // 独立标签确保拒绝连接不进入 daemon 查询/统计。这里不能在 101 响应返回前
          // close：Cloudflare 边缘可能只让客户端看到 open，吞掉关闭帧。显式协议帧会随
          // WebSocket 数据通道排队，在升级完成后可靠送达，由 daemon 主动关闭并冷却。
          this.#state.acceptWebSocket(serverEnd, ["rejected-daemon"]);
          serverEnd.send(JSON.stringify({ t: "reject", reason: "owner_conflict" }));
        } catch {
          // Signalling is best-effort; never affect the healthy daemon.
        }
        this.#runHook("daemonRejected", {
          daemonId,
          meta: daemonMeta,
          reason: "owner_conflict",
        });
        return new Response(null, { status: 101, webSocket: clientEnd });
      }

      // 同实例旧 socket 或超过新鲜度阈值的旧/legacy socket 已不再代表健康 owner，新连接接管。
      for (const old of existingDaemons) {
        try {
          old.close(1000, "replaced");
        } catch {
          // 陈旧 socket；best-effort，绝不影响即将接入的新 daemon。
        }
      }
      this.#state.acceptWebSocket(serverEnd, ["daemon"]);
      serverEnd.serializeAttachment({
        daemonId,
        openedAt: Date.now(),
        instanceId: daemonMeta.instanceId,
        meta: daemonMeta,
      });
      const clientCount = this.#state.getWebSockets("client").length;
      this.#runHook("daemonOpen", {
        daemonId,
        clientCount,
        meta: daemonMeta,
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
        online,
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
    if (tags.includes("rejected-daemon")) return;
    if (tags.includes("daemon")) {
      this.#fromDaemon(ws, frame, raw.length);
    } else {
      this.#fromClient(ws, frame, raw.length);
    }
  }

  async webSocketClose(ws, code = 0, reason = "", wasClean = false) {
    const tags = this.#state.getTags(ws);
    // 现代 daemon 的 owner_conflict 拒绝已在 fetch 记录；它不是 client，关闭时不得污染 clientClose。
    if (tags.includes("rejected-daemon")) return;
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
        meta: {
          ...(att?.meta ?? {}),
          closeReason: cleanMeta(reason, 80),
        },
        code,
        wasClean,
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
