// daemon 与 relay 的出站长连接：注册、心跳、指数退避重连、按 cid 路由
import { randomUUID } from "node:crypto";

const HEARTBEAT_MS = 25000;
const HB_TIMEOUT_MS = 10000; // hb 发出后这么久没回包即判链路死亡（网络切换/唤醒后 TCP 假活）
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;
// 连上即掉的病态循环不能每次都从 1s 开始。10 次短连接/2min 后进入 2~5min 冷却；
// 正常连接收到第一拍 hb 后清空计数，电脑唤醒/偶发抖动仍能快速恢复。
const SHORT_CONNECTION_MS = HEARTBEAT_MS;
const STORM_WINDOW_MS = 2 * 60_000;
const STORM_THRESHOLD = 10;
const STORM_COOLDOWN_MIN_MS = 2 * 60_000;
const STORM_COOLDOWN_JITTER_MS = 3 * 60_000;
const DUPLICATE_DAEMON_CLOSE_CODE = 1008;
const DUPLICATE_DAEMON_REASON = "daemon already connected";
const OWNER_CONFLICT_REJECT_REASON = "owner_conflict";
// onopen 迟迟不来的兜底：TCP/WS 握手卡死、DNS 挂起时 socket 长驻 CONNECTING，
// onopen 与 onclose 都不触发、心跳（仅 open 后起）也不跑——无此超时即永久假离线。
const CONNECT_TIMEOUT_MS = 15000;

export function daemonRelayUrl(
  relayUrl,
  daemonId,
  {
    platform = globalThis.process?.platform,
    app = "cxx",
    version = "",
    instanceId = "",
  } = {},
) {
  const base = relayUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  if (platform) params.set("os", String(platform));
  if (app) params.set("app", String(app));
  if (version) params.set("ver", String(version));
  if (instanceId) params.set("inst", String(instanceId));
  const query = params.toString();
  return `${base}/v1/daemon/${daemonId}${query ? `?${query}` : ""}`;
}

export function reconnectDelay(attempt, random = Math.random) {
  const cap = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), BACKOFF_MAX_MS);
  return Math.round(Math.max(0, Math.min(1, Number(random()) || 0)) * cap);
}

export function reconnectStormCooldown(shortDisconnects, now = Date.now(), random = Math.random) {
  const recent = shortDisconnects.filter((at) => now - at <= STORM_WINDOW_MS);
  if (recent.length < STORM_THRESHOLD) return { recent, delay: 0 };
  const r = Math.max(0, Math.min(1, Number(random()) || 0));
  return {
    recent,
    delay: STORM_COOLDOWN_MIN_MS + Math.round(r * STORM_COOLDOWN_JITTER_MS),
  };
}

// relay 已明确证明另一实例仍健康时，不走普通断线的秒级恢复节奏；低频探测既允许
// owner 退出后自动接管，也避免永久冲突实例持续消耗 Worker WebSocket 请求配额。
export function ownerConflictRetryDelay(random = Math.random) {
  const r = Math.max(0, Math.min(1, Number(random()) || 0));
  return STORM_COOLDOWN_MIN_MS + Math.round(r * STORM_COOLDOWN_JITTER_MS);
}

export class RelayLink {
  #url;
  #handlers; // { onOpen(cid), onMessage(cid, data), onClose(cid), log }
  #ws = null;
  #attempt = 0;
  #heartbeat = null;
  #lastPong = 0;
  #closed = false;
  #connectedAt = 0;
  #shortDisconnects = [];
  #random;

  constructor(relayUrl, daemonId, handlers, {
    version = "",
    instanceId = randomUUID(),
    random = Math.random,
  } = {}) {
    this.#url = daemonRelayUrl(relayUrl, daemonId, { version, instanceId });
    this.#handlers = handlers;
    this.#random = random;
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
      this.#ws = ws;
      this.#connectedAt = Date.now();
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
        case "reject":
          if (frame.reason !== OWNER_CONFLICT_REJECT_REASON || this.#ws !== ws) break;
          // Cloudflare 在 101 返回前 close 可能吞掉关闭帧；Worker 因而用显式协议帧拒绝。
          // 先摘回调再主动关闭，避免本地 close 事件重复进入普通断线退避。
          clearTimeout(connectTimer);
          ws.onclose = null;
          ws.onmessage = null;
          try { ws.close(DUPLICATE_DAEMON_CLOSE_CODE, DUPLICATE_DAEMON_REASON); } catch {}
          this.#onDisconnect(ownerConflictRetryDelay(this.#random), "owner-conflict");
          break;
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
          // open 只证明握手成功，不证明连接稳定；第一拍 25s 心跳往返成功后才清退避。
          if (this.#ws === ws) {
            this.#attempt = 0;
            this.#shortDisconnects.length = 0;
          }
          break;
        default:
          break; // 未知帧忽略，保证向前兼容
      }
    };
    ws.onclose = (event = {}) => {
      clearTimeout(connectTimer);
      // Node/旧 relay 对“不同实例且旧连接最近仍有心跳”仍可能回 1008。不能把它当终态
      //（旧 owner 退出后本实例应自然接管），但健康 owner 已被明确确认，直接转 2~5min
      // 低频探测，不能沿用普通断线的秒级恢复节奏。
      if (event.code === DUPLICATE_DAEMON_CLOSE_CODE && event.reason === DUPLICATE_DAEMON_REASON) {
        this.#onDisconnect(ownerConflictRetryDelay(this.#random), "owner-conflict");
        return;
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

  #onDisconnect(minDelay = 0, reason = "") {
    const now = Date.now();
    if (this.#connectedAt && now - this.#connectedAt < SHORT_CONNECTION_MS) {
      this.#shortDisconnects.push(now);
    }
    this.#connectedAt = 0;
    const storm = reconnectStormCooldown(this.#shortDisconnects, now, this.#random);
    this.#shortDisconnects = storm.recent;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#ws = null;
    this.#handlers.onStatus?.(false);
    if (this.#closed) return;
    let delay = reconnectDelay(this.#attempt, this.#random);
    this.#attempt += 1;
    delay = Math.max(delay, minDelay);
    if (reason === "owner-conflict") {
      this.#handlers.log(
        `relay 报告同 daemonId 有健康 owner，${Math.round(delay / 1000)}s 后低频探测接管`,
      );
    } else if (storm.delay > 0) {
      delay = Math.max(delay, storm.delay);
      this.#handlers.log(
        `relay 检测到短连接风暴（${this.#shortDisconnects.length} 次/${Math.round(STORM_WINDOW_MS / 60000)}min），` +
          `${Math.round(delay / 1000)}s 后再试`,
      );
    } else {
      this.#handlers.log(`relay 连接断开，${Math.max(0, Math.round(delay / 1000))}s 后重连`);
    }
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
