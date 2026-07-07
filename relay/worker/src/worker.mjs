// CXX Remote relay —— Cloudflare Worker + Durable Objects 变体
// 与 relay/node/server.mjs 实现相同的转发协议（见 public/PROTOCOL.md §1）。
// 使用 WebSocket Hibernation API：空闲连接不产生 duration 计费。

const PATH_RE = /^\/v1\/(daemon|client)\/([A-Za-z0-9_-]{8,64})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
      return new Response("cxx relay ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [, , daemonId] = match;
    const stub = env.ROOM.get(env.ROOM.idFromName(daemonId));
    return stub.fetch(request); // 原样透传，保留 Upgrade 语义；角色由 DO 从 URL 解析
  },
};

export class RelayRoom {
  #state;

  constructor(state) {
    this.#state = state;
    // hb 在边缘自动应答：不唤醒 DO（省 duration 计费），daemon 与手机端通用。
    // 匹配是逐字符的，两端发送串必须与这里完全一致。
    this.#state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'),
    );
  }

  async fetch(request) {
    const role = PATH_RE.exec(new URL(request.url).pathname)?.[1];
    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = [pair[0], pair[1]];

    if (role === "daemon") {
      for (const old of this.#state.getWebSockets("daemon")) {
        try {
          old.close(1000, "replaced");
        } catch {
          // 已失效
        }
      }
      this.#state.acceptWebSocket(serverEnd, ["daemon"]);
      // daemon 连接纪元：每次（重）连接递增并随 status 广播。顶替路径不广播 offline
      // （见 webSocketClose），客户端看不到 offline→online 边沿，只能靠 epoch 变化
      // 得知"daemon 侧连接态已重置、须重握手重鉴权"。存 DO storage，跨休眠仍单调。
      const epoch = ((await this.#state.storage.get("daemonEpoch")) ?? 0) + 1;
      await this.#state.storage.put("daemonEpoch", epoch);
      this.#broadcastToClients({ t: "status", online: true, epoch });
      for (const client of this.#state.getWebSockets("client")) {
        const cid = client.deserializeAttachment()?.cid;
        if (cid) serverEnd.send(JSON.stringify({ t: "open", cid })); // 补发已在线 client 的 open
      }
    } else {
      // 64 bit 随机：cid 是 daemon 侧路由键，撞号=两个客户端的帧互相串
      // （E2E 兜底为解不开丢帧，但表现为莫名收不到应答），熵给足
      const cid = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.#state.acceptWebSocket(serverEnd, ["client", `cid:${cid}`]);
      serverEnd.serializeAttachment({ cid });
      const online = this.#daemon() !== null;
      // lastSeen 存 DO storage，跨 hibernation/迁移仍可用
      const lastSeen = online ? null : ((await this.#state.storage.get("lastSeen")) ?? null);
      const epoch = online ? ((await this.#state.storage.get("daemonEpoch")) ?? null) : null;
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
      this.#fromDaemon(ws, frame);
    } else {
      this.#fromClient(ws, frame);
    }
  }

  async webSocketClose(ws) {
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      // 仅当没有其他 daemon 连接（如顶替的新连接）时才广播下线；
      // 关闭回调执行时自身可能仍在 getWebSockets 列表里，须按身份排除
      const others = this.#state.getWebSockets("daemon").filter((s) => s !== ws);
      if (others.length === 0) {
        const lastSeen = Date.now();
        await this.#state.storage.put("lastSeen", lastSeen);
        this.#broadcastToClients({ t: "status", online: false, lastSeen });
      }
      return;
    }
    const cid = ws.deserializeAttachment()?.cid;
    if (cid) this.#safeSend(this.#daemon(), JSON.stringify({ t: "close", cid }));
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  #fromDaemon(ws, frame) {
    if (frame.t === "hb") {
      this.#safeSend(ws, JSON.stringify({ t: "hb" }));
      return;
    }
    if (typeof frame.cid !== "string") return;
    const client = this.#clientByCid(frame.cid);
    if (!client) return;
    if (frame.t === "msg") {
      this.#safeSend(client, JSON.stringify({ t: "msg", data: frame.data }));
    } else if (frame.t === "close") {
      try {
        client.close(1000, "closed by daemon");
      } catch {
        // 已失效
      }
    }
  }

  #fromClient(ws, frame) {
    if (frame.t === "hb") {
      this.#safeSend(ws, '{"t":"hb"}'); // 兜底：auto-response 未生效（非休眠路径）时仍应答
      return;
    }
    if (frame.t !== "msg") return;
    const cid = ws.deserializeAttachment()?.cid;
    if (!cid) return;
    this.#safeSend(this.#daemon(), JSON.stringify({ t: "msg", cid, data: frame.data }));
  }

  // 休眠列表里可能滞留已断开但未触发 close 回调的 socket（实测会让 send() 抛
  // "Can't call WebSocket send() after close()" 并把整个 DO 打成 500），
  // 所以取 daemon 一律过滤 readyState，发送一律走 #safeSend。
  #daemon() {
    const sockets = this.#state
      .getWebSockets("daemon")
      .filter((s) => s.readyState === 1); // 1 = OPEN（workerd 的常量命名有历史差异，用数值最稳）
    return sockets.length > 0 ? sockets[sockets.length - 1] : null;
  }

  #safeSend(ws, text) {
    if (!ws) return;
    try {
      ws.send(text);
    } catch {
      // 连接已失效，忽略
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
        // 连接已失效，忽略
      }
    }
  }
}
