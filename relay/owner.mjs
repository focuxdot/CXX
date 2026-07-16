const DAEMON_FRESH_MS = 60_000;

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

export function normalizeDaemonInstanceId(value) {
  const id = String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return id.length >= 8 ? id : "";
}

// 同实例重连代表同一进程已放弃旧 socket，可直接替换；不同/未知实例只有在旧连接
// 最近仍有 hb（或尚处于首拍心跳宽限）时才拒绝后来者。
export function daemonConnectionDecision({
  incomingInstanceId = "",
  existingInstanceId = "",
  lastHeartbeatAt = 0,
  openedAt = 0,
  now = Date.now(),
  freshMs = DAEMON_FRESH_MS,
} = {}) {
  if (incomingInstanceId && incomingInstanceId === existingInstanceId) return "replace";
  const lastHealthyAt = timestampMs(lastHeartbeatAt) || timestampMs(openedAt);
  return lastHealthyAt && now - lastHealthyAt <= freshMs ? "reject" : "replace";
}

// 健康 owner 冲突需要按客户端能力分流：当前 daemon 能理解升级后的显式拒绝信号，
// 并据此进入 2–5min 低频接管探测；legacy daemon 没有实例 id，必须在 WS 升级前以 HTTP 拒绝，
// 避免旧版在 onopen 后清空退避并形成秒级连接风暴。
export function daemonConnectionAction(options = {}) {
  const incomingInstanceId = normalizeDaemonInstanceId(options.incomingInstanceId);
  const existingInstanceId = normalizeDaemonInstanceId(options.existingInstanceId);
  const decision = daemonConnectionDecision({
    ...options,
    incomingInstanceId,
    existingInstanceId,
  });
  if (decision === "replace") return "replace";
  return incomingInstanceId ? "reject-websocket" : "reject-http";
}
