// Per-action backend for the menu-bar shell (Model A).
//
// The Swift shell is a pure view: it shells out to `cxx-daemon <subcommand>` for
// every action (argv subcommand in → single JSON object out) and never holds a
// persistent connection. This module is the cross-cutting command surface, mirroring
// codex-zh's launcher/remote-backend-core.mjs. Everything here is pure config I/O
// (reuse of config.mjs / notify.mjs) except enable/disable which delegate to the
// platform keepalive layer (mac-agent.mjs) via deps.
//
// The running daemon and this CLI communicate ONLY through the config JSON on disk
// (device/notifier edits) + launchctl (lifecycle). The daemon picks up config edits
// via config-watch.mjs (fs.watch + stat poll) and per-auth re-reads. No socket/IPC.
//
// Protocol:
//   status        -> { enabled, running, deviceCount, notifierCount, relay, version }
//   enable        -> { ok, enabled, error? }     (platform hook)
//   disable       -> { ok, enabled }             (platform hook)
//   pair          -> { url } | { error }         (#d= permanent device link)
//   pair-once     -> { url } | { error }         (#p= one-time link, 5-min TTL)
//   devices       -> { devices:[{deviceId,name,createdAt,lastSeenAt, …viewer fields}] }
//   revoke <id>   -> { ok }
//   prune-unused  -> { ok, removed }
//   notify-list   -> { notifiers:[{index,label}] }
//   notify-add <inputFile>  -> { ok, count }     (input {type,key?|url?,server?} via temp file)
//   notify-remove <index>       -> { ok }
//   notify-test [inputFile]     -> { ok, count }     (tests the unsaved entry in inputFile)
//   notify-test-index <index>   -> { ok, count }     (tests the saved channel at index)
//   check-update  -> { ok, current, latest, update, url } | { error, current, url }
import { existsSync, readFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  deviceUrl,
  issueDeviceToken,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "./config.mjs";
import { Notifier, normalizeNotifier, redact } from "./notify.mjs";
import { listPtyHosts, reattachPtyHost, resolvePtyHostBin } from "./pty-adapter.mjs";
import { writeQrBmp } from "./qr-bmp.mjs";
import { compareVersions, cxxVersion } from "./version.mjs";

export function status(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : null;
  return {
    enabled: deps.isEnabled(deps),
    running: deps.isRunning(deps),
    deviceCount: config?.devices?.length ?? 0,
    notifierCount: config?.notifiers?.length ?? 0,
    relay: config?.relayUrl ?? "",
    version: cxxVersion(),
  };
}

// —— 检查更新 ——
// 查 GitHub Releases 最新 tag 与自身版本比对。托盘只拿结论：update 为真就引导去下载页。
// 网络失败（超时/离线/被墙）返回 error + 发布页兜底链接，托盘可让用户手动打开看看。
const RELEASES_API = "https://api.github.com/repos/focuxdot/CXX/releases/latest";
const RELEASES_PAGE = "https://github.com/focuxdot/CXX/releases/latest";

// 纯函数：把 API 响应整形成托盘要的结论（单测覆盖这里，网络层不掺和）。
export function shapeUpdateResult(current, release) {
  const latest = String(release?.tag_name ?? "").replace(/^v/i, "");
  if (!latest) return { error: "响应里没有版本号（tag_name 缺失）", current, url: RELEASES_PAGE };
  return {
    ok: true,
    current,
    latest,
    update: compareVersions(latest, current) > 0,
    url: release?.html_url || RELEASES_PAGE,
  };
}

export async function checkUpdate(deps, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const current = cxxVersion();
  try {
    const res = await fetchImpl(RELEASES_API, {
      headers: {
        "User-Agent": `cxx/${current}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `GitHub 返回 HTTP ${res.status}`, current, url: RELEASES_PAGE };
    return shapeUpdateResult(current, await res.json());
  } catch (err) {
    const msg = err?.name === "TimeoutError" ? "请求超时" : (err?.message ?? String(err));
    return { error: msg, current, url: RELEASES_PAGE };
  }
}

// 永久链接：内嵌长期设备令牌，扫码/点击即永久连接（可在「已配对设备」撤销）
export function pair(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  if (!config.relayUrl) return { error: "未配置 relay" };
  const { deviceToken } = issueDeviceToken(deps.configPath, config);
  return maybeAttachQr({ url: deviceUrl(loadOrCreateConfig(deps.configPath), deviceToken) }, deps);
}

// 一次性链接：5 分钟内有效、仅可用一次（适合临时发出去的场景）
export function pairOnce(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  if (!config.relayUrl) return { error: "未配置 relay" };
  const token = issuePairToken(deps.configPath, config);
  return maybeAttachQr({ url: pairUrl(loadOrCreateConfig(deps.configPath), token) }, deps);
}

function maybeAttachQr(result, deps) {
  if ((deps.platform || platform()) !== "win32" || !result?.url) return result;
  try {
    result.qrPath = writeQrBmp(result.url, join(tmpdir(), `cxx-qr-${process.pid}-${Date.now()}.bmp`));
  } catch (err) {
    deps.log?.(`qr 生成失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

// 在线观众数：daemon 在观众上下线时把按 deviceId 聚合的计数节流写入 viewer-status.json
//（本 CLI 无常驻进程，这是唯一不引协议通道的取数路径）。daemon 没在跑则视为无人围观。
function readViewerStatus(deps) {
  if (!deps.isRunning(deps)) return {};
  try {
    const p = join(dirname(deps.configPath), "viewer-status.json");
    return JSON.parse(readFileSync(p, "utf8"))?.byDevice ?? {};
  } catch {
    return {};
  }
}

export function listDevices(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { devices: [] };
  const viewers = readViewerStatus(deps);
  return {
    devices: (config.devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      name: d.name || "",
      createdAt: d.createdAt ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      // 围观链接扩展字段（全权设备缺省）：桌面设备页渲染只读徽标/会话名/时效/观众数
      ...(d.role === "viewer"
        ? {
            role: "viewer",
            sessionName: d.sessionName ?? "",
            expiresAt: d.expiresAt ?? null,
            muted: d.muted === true,
            url: d.url ?? null,
            viewers: viewers[d.deviceId] ?? 0,
          }
        : {}),
    })),
  };
}

export function revokeDevice(deps, deviceId) {
  const config = loadOrCreateConfig(deps.configPath);
  const before = (config.devices ?? []).length;
  config.devices = (config.devices ?? []).filter((d) => d.deviceId !== deviceId);
  saveConfig(deps.configPath, config);
  return { ok: config.devices.length < before };
}

// 清理"从未连接"的设备（lastSeenAt 空）——即生成过但没人扫过的链接。移除它们等于
// 作废这些悬空令牌：曾外泄/转发但没被使用的链接随即失效（撤销即时生效，因 daemon
// 每次鉴权重读配置 + config-watch 热核对）。围观链接除外（永久分享链接长期无人点开合法）。
export function pruneUnusedDevices(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  const before = (config.devices ?? []).length;
  config.devices = (config.devices ?? []).filter((d) => d.lastSeenAt || d.role === "viewer");
  const removed = before - config.devices.length;
  saveConfig(deps.configPath, config);
  return { ok: true, removed };
}

export function notifyList(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { notifiers: [] };
  return { notifiers: (config.notifiers ?? []).map((n, index) => ({ index, label: redact(n) })) };
}

export function notifyAdd(deps, entry) {
  const config = loadOrCreateConfig(deps.configPath);
  config.notifiers = config.notifiers ?? [];
  config.notifiers.push(normalizeNotifier(entry));
  saveConfig(deps.configPath, config);
  return { ok: true, count: config.notifiers.length };
}

export function notifyRemove(deps, index) {
  const config = loadOrCreateConfig(deps.configPath);
  config.notifiers = config.notifiers ?? [];
  if (index < 0 || index >= config.notifiers.length) return { ok: false };
  config.notifiers.splice(index, 1);
  saveConfig(deps.configPath, config);
  return { ok: true };
}

// 测试输入框里刚填、尚未「添加」的一条渠道（不落盘，纯 dry-run）。
export async function notifyTest(deps, entry) {
  const notifier = new Notifier(entry ? [normalizeNotifier(entry)] : [], { log: deps.log });
  await notifier.send("ChatGPT 远程测试", "如果你收到这条，说明通知渠道配置成功 ✅");
  return { ok: true, count: notifier.count };
}

// 测试某个已配置渠道（按 index，供「已配置」列表每行的测试按钮用）。
export async function notifyTestIndex(deps, index) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { notifiers: [] };
  const list = config.notifiers ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return { ok: false, count: 0 };
  const notifier = new Notifier([list[index]], { log: deps.log });
  await notifier.send("ChatGPT 远程测试", "如果你收到这条，说明通知渠道配置成功 ✅");
  return { ok: true, count: notifier.count };
}

// —— Terminal Mode（internal/TERMINAL-MODE.md §4.8/§13.1）——
// 桌面壳的终端管理面：全局开关 + 逐设备授权（写配置，daemon config-watch 热生效）、
// 运行中终端可见性与电脑侧结束。真相在 pty-host 注册目录（磁盘），CLI 无常驻进程
// 也能读；结束直接连 host 的本机 socket 发 CLOSE，不经 daemon。
function ptyBaseDir(deps) {
  return join(dirname(deps.configPath), "pty");
}

export function terminalStatus(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : null;
  const hosts = listPtyHosts(ptyBaseDir(deps));
  return {
    enabled: config?.terminalEnabled === true,
    hostAvailable: Boolean(resolvePtyHostBin(config?.ptyHostPath)),
    // 菜单栏「终端 · N」的 N = 存活 host 数；列表含 title/cwd 供点开查看与结束
    terminals: hosts.map((h) => ({
      terminalId: h.terminalId,
      title: h.meta?.title ?? h.terminalId,
      cwd: h.meta?.cwd ?? "",
      presetName: h.meta?.presetName ?? "",
      startedAt: h.startedAt ?? null,
      alive: h.alive,
      exit: h.exit ?? null,
    })),
    devices: (config?.devices ?? [])
      .filter((d) => d.role !== "viewer")
      .map((d) => ({
        deviceId: d.deviceId,
        name: d.name || "",
        terminalAccess: d.terminalAccess === true,
      })),
  };
}

export function terminalEnable(deps, enabled) {
  const config = loadOrCreateConfig(deps.configPath);
  config.terminalEnabled = enabled === true;
  saveConfig(deps.configPath, config);
  return { ok: true, enabled: config.terminalEnabled };
}

export function terminalAccess(deps, deviceId, allowed) {
  const config = loadOrCreateConfig(deps.configPath);
  const device = (config.devices ?? []).find((d) => d.deviceId === deviceId && d.role !== "viewer");
  if (!device) return { ok: false, error: "设备不存在" };
  device.terminalAccess = allowed === true;
  saveConfig(deps.configPath, config);
  return { ok: true, deviceId, terminalAccess: device.terminalAccess };
}

// 电脑侧结束一个终端（§4.8 信任对称）：直连该 host 的 socket 发 CLOSE
//（host 自会 SIGTERM→SIGKILL 子进程并自灭）。host 已死则只清注册目录残骸。
export async function terminalClose(deps, terminalId) {
  if (!/^[\w.-]+$/.test(String(terminalId ?? ""))) return { ok: false, error: "terminalId 非法" };
  const host = listPtyHosts(ptyBaseDir(deps)).find((h) => h.terminalId === terminalId);
  if (!host) return { ok: false, error: "终端不存在" };
  if (!host.alive) return { ok: true, alreadyExited: true };
  try {
    const { client } = await reattachPtyHost({ dir: host.dir, sinceSeq: Number.MAX_SAFE_INTEGER, timeoutMs: 3000 });
    client.close();
    await new Promise((r) => setTimeout(r, 300)); // 给 CLOSE 帧冲刷的时间
    client.disconnect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// —— CLI 分发 —— enable/disable 走平台钩子（mac/win/linux-agent），其余纯 config 逻辑。
export async function runMenuCommand(command, rest, deps) {
  switch (command) {
    case "status": return status(deps);
    case "enable": return deps.enable(deps);
    case "disable": return deps.disable(deps);
    case "pair": return pair(deps);
    case "pair-once": return pairOnce(deps);
    case "devices": return listDevices(deps);
    case "revoke": return revokeDevice(deps, rest[0]);
    case "prune-unused": return pruneUnusedDevices(deps);
    case "notify-list": return notifyList(deps);
    case "notify-add": return notifyAdd(deps, JSON.parse(readFileSync(rest[0], "utf8")));
    case "notify-remove": return notifyRemove(deps, Number(rest[0]));
    case "notify-test": return notifyTest(deps, rest[0] ? JSON.parse(readFileSync(rest[0], "utf8")) : undefined);
    case "notify-test-index": return notifyTestIndex(deps, Number(rest[0]));
    case "check-update": return checkUpdate(deps);
    case "terminal-status": return terminalStatus(deps);
    case "terminal-enable": return terminalEnable(deps, rest[0] !== "0" && rest[0] !== "false");
    case "terminal-access": return terminalAccess(deps, rest[0], rest[1] !== "0" && rest[1] !== "false");
    case "terminal-close": return terminalClose(deps, rest[0]);
    default: return null; // not a menu command
  }
}

export const MENU_COMMANDS = new Set([
  "status", "enable", "disable", "pair", "pair-once", "devices",
  "revoke", "prune-unused", "notify-list", "notify-add", "notify-remove", "notify-test", "notify-test-index",
  "check-update",
  "terminal-status", "terminal-enable", "terminal-access", "terminal-close",
]);
