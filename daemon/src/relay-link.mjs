// daemon 与 relay 的出站长连接：注册、心跳、指数退避重连、按 cid 路由
const HEARTBEAT_MS = 25000;
const HB_TIMEOUT_MS = 10000; // hb 发出后这么久没回包即判链路死亡（网络切换/唤醒后 TCP 假活）
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15000; // 上限太高会让电脑唤醒后长时间假离线
const DUPLICATE_DAEMON_CLOSE_CODE = 1008;
const DUPLICATE_DAEMON_REASON = "daemon already connected";
// onopen 迟迟不来的兜底：TCP/WS 握手卡死、DNS 挂起时 socket 长驻 CONNECTING，
// onopen 与 onclose 都不触发、心跳（仅 open 后起）也不跑——无此超时即永久假离线。
const CONNECT_TIMEOUT_MS = 15000;

export function daemonRelayUrl(
  relayUrl,
  daemonId,
  { platform = globalThis.process?.platform, app = "cxx" } = {},
) {
  const base = relayUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  if (platform) params.set("os", String(platform));
  if (app) params.set("app", String(app));
  const query = params.toString();
  return `${base}/v1/daemon/${daemonId}${query ? `?${query}` : ""}`;
}

export class RelayLink {
  #url;
  #handlers; // { onOpen(cid), onMessage(cid, data), onClose(cid), log }
  #ws = null;
  #attempt = 0;
  #heartbeat = null;
  #lastPong = 0;
  #closed = false;

  constructor(relayUrl, daemonId, handlers) {
    this.#url = daemonRelayUrl(relayUrl, daemonId);
    this.#handlers = handlers;
  }

  start() {
    this.#connect();
  }

  #connect() {
    if (this.#closed) return;
    let ws;
    try {
      ws = new WebSocket(this.#url);
    } catch (err) {
      // 构造即抛（瞬时资源/URL 解析错误）：本方法多经 setTimeout 回调进入，
      // 异常逸出会被运行时吞掉、既无 onclose 也无下次重连——重连链就此死死。
      this.#handlers.log(`relay 连接创建失败：${err?.message ?? err}`);
      this.#onDisconnect();
      return;
    }
    // 握手兜底计时器：onopen 建连成功、onclose 建连失败——二者都不来（卡在 CONNECTING）
    // 时由它判死并重连。onopen/onclose 命中即清除，故它只在真·卡死时触发。
    const connectTimer = setTimeout(() => {
      if (this.#closed || this.#ws === ws) return; // 已 open 或已停止
      this.#handlers.log("relay 建连握手超时，判定链路死亡，重连");
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      try { ws.close(); } catch {}
      this.#onDisconnect();
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    ws.onopen = () => {
      clearTimeout(connectTimer);
      this.#attempt = 0;
      this.#ws = ws;
      this.#lastPong = Date.now();
      this.#handlers.log(`已连接 relay: ${this.#url}`);
      this.#handlers.onStatus?.(true);
      this.#heartbeat = setInterval(() => this.#beat(ws), HEARTBEAT_MS);
      this.#heartbeat.unref?.();
    };
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (frame.t) {
        case "open":
          this.#handlers.onOpen(frame.cid);
          break;
        case "msg":
          this.#handlers.onMessage(frame.cid, frame.data);
          break;
        case "close":
          this.#handlers.onClose(frame.cid);
          break;
        case "hb":
          this.#lastPong = Date.now();
          break;
        default:
          break; // 未知帧忽略，保证向前兼容
      }
    };
    ws.onclose = (event = {}) => {
      clearTimeout(connectTimer);
      // 旧版 relay 会对“同 daemonId 已有连接”回 1008。本进程能运行就必然持有单实例锁
      // （daemon-lock.mjs），没有第二个合法 daemon 能占用这个 daemonId——故这类 1008 只可能
      // 是自己上一条连接的服务端 socket 尚未断干净造成的假阳性。绝不能据此永久停摆
      //（曾因此假离线数小时直到手动重启），照常退避重连即可：新版 relay 会让新连接顶掉旧的。
      if (event.code === DUPLICATE_DAEMON_CLOSE_CODE && event.reason === DUPLICATE_DAEMON_REASON) {
        this.#handlers.log("relay 报告同 daemonId 已在线（多为自身旧连接残留），继续重连");
      }
      this.#onDisconnect();
    };
    ws.onerror = () => {};
  }

  // 心跳发出后限时验收回包。TCP 假活时 send 不报错、onclose 几分钟不来，
  // 只有"发了没回"能及时暴露死链——超时就摘回调、掐连接、走重连。
  #beat(ws) {
    const sentAt = Date.now();
    this.#sendRaw({ t: "hb" });
    setTimeout(() => {
      if (this.#closed || this.#ws !== ws) return; // 已换连接/已停止
      if (this.#lastPong >= sentAt) return;
      this.#handlers.log("relay 心跳超时，判定链路死亡，重连");
      ws.onclose = null;
      ws.onmessage = null; // 垂死连接缓冲中的迟到帧不得与新连接的帧交错送入路由
      try { ws.close(); } catch {}
      this.#onDisconnect();
    }, HB_TIMEOUT_MS).unref?.();
  }

  #onDisconnect() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#ws = null;
    this.#handlers.onStatus?.(false);
    if (this.#closed) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    this.#attempt += 1;
    this.#handlers.log(`relay 连接断开，${Math.round(delay / 1000)}s 后重连`);
    setTimeout(() => this.#connect(), delay).unref?.();
  }

  // relay WebSocket 的未冲刷字节数：观众帧低优先级排空的水位依据
  get bufferedAmount() {
    return this.#ws?.bufferedAmount ?? 0;
  }

  send(cid, data) {
    this.#sendRaw({ t: "msg", cid, data });
  }

  closeClient(cid) {
    this.#sendRaw({ t: "close", cid });
  }

  #sendRaw(frame) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }

  stop() {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#ws?.close();
  }
}
