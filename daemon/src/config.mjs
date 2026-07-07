// daemon 配置与状态：~/.cxx/remote/daemon.json
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { generateKeyPair, randomId, randomToken } from "./crypto.mjs";

export const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;

// 应用层协议版本（daemon ↔ client）。relay 转发协议版本另见 URL 的 /v1/ 前缀。
// 不兼容变更时递增：daemon 与 client 在 auth 握手交换，一端过旧则提示升级。
export const APP_PROTOCOL = 1;

export function defaultConfigPath() {
  return join(homedir(), ".cxx", "remote", "daemon.json");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function loadOrCreateConfig(path = defaultConfigPath()) {
  if (existsSync(path)) {
    // 去掉可能的 UTF-8 BOM：Windows 上用 PowerShell/记事本等改写配置常带 BOM，
    // Node 以 "utf8" 读不会自动剥离，JSON.parse 会在首字符处报错、daemon 直接崩。
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  }
  const keys = generateKeyPair();
  const config = {
    v: 1,
    daemonId: randomId(),
    daemonName: hostname(),
    publicKey: keys.publicKeyRaw.toString("base64"),
    privateKeyPem: keys.privateKeyPem,
    relayUrl: "wss://relay.wokey.ai", // 官方 relay；可用 start --relay 覆盖为自建实例
    webUrl: "https://focuxdot.github.io/CXX/", // 配对链接指向的手机端页面（GitHub Pages）；可用 start --web 覆盖

    codexCommand: "codex",
    claudeCommand: "claude", // Claude Code CLI；二进制存在时自动作为可切换 agent 提供
    // Claude 轮次默认权限模式（default/plan/acceptEdits/bypassPermissions）。装了 PreToolUse
    // 审批 hook 后，需审批的工具会路由到手机；此项管未拦截工具与 plan 模式的默认行为。
    claudePermissionMode: "default",
    appServerPort: 19271,
    preventSleep: true, // 有设备在线或任务运行时阻止系统睡眠（允许关屏）
    notifiers: [], // webhook 通知渠道 [{type:"bark",key} | {type:"wecom",url} ...]
    devices: [],
    pairTokens: [],
  };
  saveConfig(path, config);
  return config;
}

export function saveConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// 生成一次性配对令牌（只存哈希），返回明文
export function issuePairToken(path, config) {
  const token = randomToken();
  const now = Date.now();
  config.pairTokens = (config.pairTokens ?? []).filter((t) => t.expiresAt > now);
  config.pairTokens.push({ hash: sha256(token), expiresAt: now + PAIR_TOKEN_TTL_MS });
  saveConfig(path, config);
  return token;
}

// 创建一个设备条目并铸造其明文设备令牌（只在配置里存哈希）。
// 由配对消费（consumePairToken）、永久链接签发（issueDeviceToken）与围观链接
// 签发（issueViewerToken）共用，避免结构漂移。extra 承载围观扩展字段
// （role/scope/expiresAt/sessionName/muted/url），存量调用不传即无这些字段。
function createDevice(config, name = "", extra = {}) {
  const now = Date.now();
  const device = {
    deviceId: randomId(8),
    tokenHash: null,
    name,
    createdAt: now,
    lastSeenAt: null, // 尚未真正连接过；首次鉴权成功时才写入（也用于"新设备首次连接"提醒判定）
    ...extra,
  };
  const deviceToken = randomToken();
  device.tokenHash = sha256(deviceToken);
  config.devices.push(device);
  return { device, deviceToken };
}

// —— 围观（单会话只读）——
// 缺省无 role 字段即全权，与存量设备兼容；权限判定一律以此处条目为准，
// 链接载荷里的 ro/sid/sname 仅是给观众端 UI 的显示提示。
export function isViewerDevice(device) {
  return device?.role === "viewer";
}

// expiresAt 为 null/缺省 = 永久档；仅数字且已过即过期
export function isDeviceExpired(device, now = Date.now()) {
  return typeof device?.expiresAt === "number" && device.expiresAt <= now;
}

// 校验并消费配对令牌；daemon 进程在每次配对尝试时重读配置，
// 使 `pair` 命令在独立进程中签发的令牌立即生效。
export function consumePairToken(path, token) {
  const config = loadOrCreateConfig(path);
  const now = Date.now();
  const hash = sha256(token);
  const found = (config.pairTokens ?? []).find((t) => t.hash === hash && t.expiresAt > now);
  if (!found) return null;
  config.pairTokens = config.pairTokens.filter((t) => t !== found && t.expiresAt > now);
  const { device, deviceToken } = createDevice(config);
  saveConfig(path, config);
  return { config, device, deviceToken };
}

// 直接签发一个长期设备令牌（永久链接/QR 用）——等价于配对消费的产物，
// 但无需一次性配对令牌换取。物理在场扫码/主动生成即可，安全性由"链接含长期凭据"承担。
export function issueDeviceToken(path, config, { name = "" } = {}) {
  const { device, deviceToken } = createDevice(config, name);
  saveConfig(path, config);
  return { device, deviceToken };
}

export function findDeviceByToken(config, deviceToken) {
  const hash = sha256(deviceToken);
  return (config.devices ?? []).find((d) => d.tokenHash === hash) ?? null;
}

// 按浏览器身份归并：同一浏览器（clientId 相同——手机端存在 localStorage 里的随机 id，
// 按浏览器/站点隔离，故微信/Chrome/Firefox 各算一台）重新配对时，作废它名下的旧凭据，
// 只保留当前这条，使"同一浏览器 = 一台设备"。副带好处：旧链接一旦被同浏览器重配即失效，
// 万一外泄更安全。围观条目是共享凭据、绝不参与归并。返回被作废的 deviceId 列表（供踢下线）。
export function mergeDevicesByClient(config, keepDeviceId, clientId) {
  if (!clientId) return [];
  const removed = [];
  config.devices = (config.devices ?? []).filter((d) => {
    if (d.deviceId === keepDeviceId) return true;
    if (isViewerDevice(d)) return true;
    if (d.clientId && d.clientId === clientId) {
      removed.push(d.deviceId);
      return false;
    }
    return true;
  });
  return removed;
}

export function buildPairPayload(config, pairToken) {
  return {
    v: 1,
    relay: config.relayUrl,
    id: config.daemonId,
    pk: config.publicKey,
    name: config.daemonName,
    tok: pairToken,
  };
}

export function pairUrl(config, pairToken) {
  const payload = Buffer.from(JSON.stringify(buildPairPayload(config, pairToken))).toString(
    "base64url",
  );
  const base = config.webUrl || "https://example.invalid/remote";
  return `${base}#p=${payload}`;
}

// 永久链接载荷：内嵌长期设备令牌（dtok），手机端据此直接走设备令牌认证，无需再换取。
// 字段名 dtok 区别于一次性配对令牌的 tok。
export function buildDevicePayload(config, deviceToken) {
  return {
    v: 1,
    relay: config.relayUrl,
    id: config.daemonId,
    pk: config.publicKey,
    name: config.daemonName,
    dtok: deviceToken,
  };
}

export function deviceUrl(config, deviceToken) {
  const payload = Buffer.from(JSON.stringify(buildDevicePayload(config, deviceToken))).toString(
    "base64url",
  );
  const base = config.webUrl || "https://example.invalid/remote";
  return `${base}#d=${payload}`;
}

// 围观链接载荷：沿用 #d= 机制，追加只读提示字段供观众端 UI 渲染。
// ro=1 只读标记；sid 目标会话；sname 会话名（截断控制载荷与 QR 体积）。
export function buildViewerPayload(config, deviceToken, { sessionId, sessionName = "", agent = "codex" }) {
  return {
    ...buildDevicePayload(config, deviceToken),
    ro: 1,
    sid: sessionId,
    sname: String(sessionName).slice(0, 20),
    agent,
  };
}

export function viewerUrl(config, deviceToken, opts) {
  const payload = Buffer.from(
    JSON.stringify(buildViewerPayload(config, deviceToken, opts)),
  ).toString("base64url");
  const base = config.webUrl || "https://example.invalid/remote";
  return `${base}#d=${payload}`;
}

// 签发一条围观链接：单会话只读设备条目 + 内嵌其令牌的链接。
// 条目名固定为「围观链接 · 会话名」（viewer 鉴权不用 UA 改写它）；
// 明文 url 存回条目——分享弹窗对已有链接提供"复制"，令牌仅授权单会话只读，
// 能读到配置文件的人本就能读全部会话，静态明文不引入新风险。
export function issueViewerToken(path, config, { sessionId, sessionName = "", ttlMs = null, agent = "codex" }) {
  const shortName = String(sessionName).slice(0, 20);
  const { device, deviceToken } = createDevice(config, `围观链接 · ${shortName || sessionId}`, {
    role: "viewer",
    scope: { sessionId, agent },
    sessionName: shortName,
    expiresAt: ttlMs ? Date.now() + ttlMs : null,
    muted: false,
  });
  device.url = viewerUrl(config, deviceToken, { sessionId, sessionName: shortName, agent });
  saveConfig(path, config);
  return { device, deviceToken };
}
