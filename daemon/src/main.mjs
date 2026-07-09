#!/usr/bin/env node
// CXX daemon 入口（C叉叉 — 官方 Codex 的独立手机远程控制）
// 用法：
//   node daemon/src/main.mjs start [--config <path>] [--relay <wss://...>] [--codex <cmd>]
//   node daemon/src/main.mjs pair  [--config <path>]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import { AppServer, reapStaleAppServer } from "./app-server.mjs";
import { ClaudeBackend } from "./claude-backend.mjs";
import { ClientSession } from "./client-session.mjs";
import { resolveCodexCommand } from "./codex-path.mjs";
import { MIN_CODEX_VERSION, checkCodexVersion } from "./codex-version.mjs";
import { claudeAvailable, resolveClaudeCommand } from "./claude-path.mjs";
import { MIN_CLAUDE_VERSION, checkClaudeVersion } from "./claude-version.mjs";
import { resolveAppServerPort } from "./free-port.mjs";
import {
  PAIR_TOKEN_TTL_MS,
  defaultConfigPath,
  isDeviceExpired,
  isViewerDevice,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "./config.mjs";
import { enforceDevices, watchConfig } from "./config-watch.mjs";
import { privateKeyFromPem } from "./crypto.mjs";
import { Notifier, normalizeNotifier, redact } from "./notify.mjs";
import { MENU_COMMANDS, runMenuCommand } from "./menu-backend.mjs";
import { makeDeps as makeMacAgentDeps } from "./mac-agent.mjs";
import { makeDeps as makeWinAgentDeps } from "./win-agent.mjs";
import { PowerManager } from "./power.mjs";
import { RelayLink } from "./relay-link.mjs";
import { SessionHub } from "./session-hub.mjs";
import { resolve as resolvePath, sep as pathSep } from "node:path";

// Windows 上 daemon 由计划任务拉起，<Exec> 无法重定向 stdout（Mac 靠 launchd 的
// StandardOutPath 落 daemon.log）。故 win32 下 daemon 自行把日志追加到 daemon.log，
// 与 Mac 对齐、便于排障。logFile 由 startDaemon 按 configPath 设定。
let logFile = null;
// IPC 模式：stdout 专用于 newline-delimited JSON 事件流，故日志改走 log 事件，
// 绝不能再往 stdout 打散字符串，否则壳端 JSON 解析被污染。
let ipcMode = false;
function emitEvent(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (ipcMode) emitEvent({ event: "log", line });
  else console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // 落盘失败不影响 daemon 运行
    }
  }
}

function makeMenuDeps({ configPath }) {
  const base = {
    configPath,
    log: (m) => process.stderr.write(`${m}\n`),
  };
  if (process.platform === "darwin") return makeMacAgentDeps(base);
  if (process.platform === "win32") return makeWinAgentDeps(base);
  return {
    ...base,
    isEnabled: () => false,
    isRunning: () => false,
    enable: () => ({ ok: false, enabled: false, error: "仅支持 macOS / Windows" }),
    disable: () => ({ ok: true, enabled: false }),
  };
}

// emit: 可选的结构化事件回调（IPC 模式下由 --ipc 提供，写 stdout JSON 行）。
// 默认 no-op，CLI/冒烟直跑不受影响。事件形如 { event, ... }。
export async function startDaemon({ configPath, overrides = {}, emit = () => {} }) {
  const config = loadOrCreateConfig(configPath);
  // win32：daemon 自记日志到 config 同目录的 daemon.log（计划任务无法重定向 stdout）
  if (process.platform === "win32") {
    logFile = join(dirname(configPath), "daemon.log");
    try {
      mkdirSync(dirname(logFile), { recursive: true });
    } catch {
      // 目录已存在或不可建，忽略
    }
  }
  let changed = false;
  for (const key of ["relayUrl", "webUrl", "codexCommand", "claudeCommand"]) {
    if (overrides[key] && overrides[key] !== config[key]) {
      config[key] = overrides[key];
      changed = true;
    }
  }
  if (changed) saveConfig(configPath, config);
  if (!config.relayUrl) {
    throw new Error("未配置 relay 地址：用 --relay wss://... 指定（会持久化到配置文件）");
  }
  // 运行时开关：--no-prevent-sleep 覆盖为不阻止睡眠（不持久化）
  if (overrides.preventSleep === false) config.preventSleep = false;

  // 解析 codex 绝对路径：从 Finder/Dock 启动的壳继承的 PATH 极简，bare "codex" 找不到。
  const resolvedCodex = resolveCodexCommand(config.codexCommand);
  if (resolvedCodex !== config.codexCommand) {
    log(`codex 解析为绝对路径: ${resolvedCodex}`);
  }
  // 兼容性门槛（app-server 仍是 experimental）：太旧的 codex 会在会话中途以晦涩的 RPC 错误失败，
  // 这里在启动早期就以明确报错拦下。版本串解析不出（如未来格式变更）只告警不拦，避免误伤新版。
  const codexVersion = checkCodexVersion(resolvedCodex);
  emit({ event: "version", codex: codexVersion.raw, ok: codexVersion.ok, min: MIN_CODEX_VERSION });
  if (codexVersion.belowMin) {
    throw new Error(
      `codex 版本过低：检测到「${codexVersion.raw}」，本程序要求 ≥ ${MIN_CODEX_VERSION}。` +
        `请升级官方 Codex（如 brew upgrade codex 或 npm i -g @openai/codex），再重试。`,
    );
  }
  if (codexVersion.raw) log(`codex 版本: ${codexVersion.raw}（最低要求 ${MIN_CODEX_VERSION}）`);
  else log(`未能读取 codex 版本（--version 无输出或格式未知），跳过版本校验，继续启动`);
  // 选一个空闲端口：默认 19271 常被官方 Codex remote-control/app-server 守护进程占用，
  // 我们跑自己的 app-server 实例，不能与官方抢端口——被占则退到系统分配的临时端口。
  const { port: appServerPort, fallback } = await resolveAppServerPort(config.appServerPort);
  if (fallback) {
    log(`app-server 首选端口 ${config.appServerPort} 被占用（可能是官方 Codex），改用 ${appServerPort}`);
  }
  // 起新引擎前先清理上次崩溃/被强杀遗留的 codex（正常 stop 不会有残留；此为兜底）
  const appServerPidFile = join(dirname(configPath), "app-server.pid");
  reapStaleAppServer(appServerPidFile, log);
  const appServer = new AppServer({
    command: resolvedCodex,
    port: appServerPort,
    log,
    pidFile: appServerPidFile,
  });
  try {
    await appServer.start();
  } catch (err) {
    // 引擎起不来最常见就是找不到 codex——给壳一条可读的错误而不是裸 ENOENT。
    const errText = String(err?.message ?? err);
    const hint =
      resolvedCodex === "codex" || /ENOENT/.test(errText)
        ? "：未找到 codex，请先安装官方 Codex（codex --version 应可用），或用 --codex <路径> 指定"
        : /EPERM|EACCES/i.test(errText)
          ? "：无法执行 codex，请确认 Windows 上指向的是 codex.exe/codex.cmd；如当前是 codex.ps1，可用 --codex 指定同目录的 codex.cmd"
        : "";
    throw new Error(`codex app-server 启动失败${hint}（${err.message}）`);
  }
  log(`codex app-server 就绪: ${appServer.url}`);

  const power = new PowerManager({ log });
  // let（非 const）：配置文件变更时（桌面「通知设置」走独立 CLI 进程写盘 notifiers）
  // 在 onConfig 里重建 Notifier，让渠道增删对运行中的 daemon 即时生效，无需重启。
  let notifier = new Notifier(config.notifiers ?? [], { log });
  // 会话名缓存（通知文案用会话 name，不用 preview，避免泄露首条消息内容）
  const nameCache = new Map();
  async function sessionName(id, backend = appServer) {
    if (!nameCache.has(id)) {
      try {
        for (const t of await backend.listThreads(200)) nameCache.set(t.id, t.name || "");
      } catch {
        // 查询失败则用兜底名
      }
    }
    return nameCache.get(id) || "一个会话";
  }
  // 在线观众数落盘（节流）：桌面设备页是无常驻进程的 CLI，靠读此文件拿"N 人正在围观"。
  // daemon 启动时也写一次，清掉上次异常退出的残留计数。
  const viewerStatusFile = join(dirname(configPath), "viewer-status.json");
  let viewerStatusTimer = null;
  function scheduleViewerStatusWrite() {
    if (viewerStatusTimer) return;
    viewerStatusTimer = setTimeout(() => {
      viewerStatusTimer = null;
      try {
        const byDevice = {};
        for (const h of Object.values(hubs)) {
          for (const [deviceId, count] of Object.entries(h.viewerStats())) {
            byDevice[deviceId] = (byDevice[deviceId] ?? 0) + count;
          }
        }
        writeFileSync(viewerStatusFile, JSON.stringify({ ts: Date.now(), byDevice }));
      } catch {}
    }, 1000);
    viewerStatusTimer.unref?.();
  }

  const hub = new SessionHub(appServer, {
    log,
    agent: "codex",
    onAwakeChange(want) {
      if (config.preventSleep === false) return;
      want ? power.acquire() : power.release();
    },
    onViewersChange: scheduleViewerStatusWrite,
    async onEvent(type, { sessionId, clientsOnline }) {
      const name = await sessionName(sessionId);
      // 注：codex-zh 的「桌面 GUI 刷新横幅」依赖对官方 app.asar 的注入，本独立项目
      // 不做该注入，故不迁移 desktop-signal。手机操作链路不受影响；桌面 TUI 用户
      // resume 会话时自然刷新。详见 README「与官方 Codex 的关系」。
      if (notifier.count === 0) return;
      // 深链：点通知直达该会话（只含页面地址 + 会话 id，不含内容）
      const link = config.webUrl
        ? `${config.webUrl.replace(/\/+$/, "/")}#s=${encodeURIComponent(sessionId)}`
        : undefined;
      if (type === "approval") {
        // 审批总是推（头号阻塞）
        await notifier.send("Codex 需要审批", `会话「${name}」有操作待你批准，请打开 Codex 远程处理`, link);
      } else if (type === "turnCompleted" && clientsOnline === 0) {
        // 任务完成仅在无设备在线时推，避免用户正在看时打扰
        await notifier.send("Codex 任务完成", `会话「${name}」已完成`, link);
      }
    },
  });
  // 引擎状态变化（崩溃自动重拉期间）推给手机端，供分层连接诊断；同时上报壳 IPC
  appServer.onStateChange = (healthy) => {
    // 掉线先善后：旧引擎里的 turn/审批已随进程死亡，清运行态并广播（否则看板卡"运行中"）
    if (!healthy) hub.engineReset();
    hub.broadcastEngineState(healthy);
    emit({ event: "engine", healthy });
  };

  // —— Claude Code 后端（可选，第二个可切换 agent）——
  // 官方 codex app-server 是常驻 JSON-RPC；Claude Code 没有等价服务，ClaudeBackend
  // 读取直接走 ~/.claude/projects 的 JSONL、写入走 claude -p 流式（见 claude-backend.mjs）。
  // 仅当检测到 claude 二进制时注册——缺失即不提供该 agent，手机端下拉自然只剩 Codex。
  const backends = { codex: appServer };
  const hubs = { codex: hub };
  if (claudeAvailable(config.claudeCommand)) {
    const resolvedClaude = resolveClaudeCommand(config.claudeCommand);
    const claudeVer = checkClaudeVersion(resolvedClaude);
    emit({ event: "version", agent: "claude", raw: claudeVer.raw, ok: claudeVer.ok, min: MIN_CLAUDE_VERSION });
    if (claudeVer.belowMin) {
      log(`Claude Code 版本过低（${claudeVer.raw} < ${MIN_CLAUDE_VERSION}），跳过 Claude agent 注册`);
    } else {
      const claudeBackend = new ClaudeBackend({
        command: resolvedClaude,
        log,
        permissionMode: config.claudePermissionMode || "default",
        archivePath: join(dirname(configPath), "claude-archive.json"),
      });
      await claudeBackend.start();
      // 每个后端一套 SessionHub：各自持有 resume 状态/审批/当前 turn。Claude hub 与
      // 电源管理共享（有活动就别睡）；通知（onEvent）待 Phase 3 写入链路完成再接。
      const claudeHub = new SessionHub(claudeBackend, {
        log,
        agent: "claude",
        onAwakeChange(want) {
          if (config.preventSleep === false) return;
          want ? power.acquire() : power.release();
        },
        onViewersChange: scheduleViewerStatusWrite,
        // 无头 Claude 每轮结束即交还控制权（等你下一条消息），故"轮次完成"就是"轮到你了"的信号。
        // 审批总是推（头号阻塞）；轮次完成仅在无设备在线时推（你正在看就别打扰）。深链带 a=claude 直达该 agent。
        async onEvent(type, { sessionId, clientsOnline }) {
          if (notifier.count === 0) return;
          const name = await sessionName(sessionId, claudeBackend);
          const link = config.webUrl
            ? `${config.webUrl.replace(/\/+$/, "/")}#s=${encodeURIComponent(sessionId)}&a=claude`
            : undefined;
          if (type === "approval") {
            await notifier.send("Claude 需要审批", `会话「${name}」有操作待你批准`, link);
          } else if (type === "turnCompleted" && clientsOnline === 0) {
            await notifier.send("Claude 等你输入", `会话「${name}」回合结束，轮到你回复`, link);
          }
        },
      });
      backends.claude = claudeBackend;
      hubs.claude = claudeHub;
      log(`Claude Code agent 已注册: ${resolvedClaude}（版本 ${claudeVer.raw ?? "未知"}）`);
    }
  }

  const sessions = new Map(); // cid -> ClientSession
  const daemonContext = {
    config,
    configPath,
    privateKey: privateKeyFromPem(config.privateKeyPem),
    appServer, // 默认 agent（codex）后端，向后兼容既有代码路径
    hub, // 默认 agent（codex）hub
    backends, // { codex, claude? } —— 按 agent 路由
    hubs, // { codex, claude? }
    // 手机端下拉可选的 agent 列表（仅注册成功的后端）
    availableAgents() {
      const label = { codex: "Codex", claude: "Claude Code" };
      return Object.keys(backends).map((id) => ({
        id,
        name: label[id] ?? id,
        healthy: backends[id]?.healthy ?? false,
      }));
    },
    log,
    // relay 上行水位（观众帧低优先级排空的依据）；relay 在下方初始化，运行期才会被调用
    getBufferedAmount: () => relay.bufferedAmount,
    // 按 deviceId 断开全部在线连接（share.revoke 协议路径用）。
    // 连接数百级，O(n) 扫描比维护双写索引简单且不会失同步。
    kickDevice(deviceId) {
      for (const session of sessions.values()) {
        if (session.deviceId === deviceId) session.kick();
      }
    },
    // 新建会话的目录白名单：未配置则允许任意（r0.6 安装器会写入默认白名单）
    isCwdAllowed(cwd) {
      const allow = config.allowedCwds;
      if (!Array.isArray(allow) || allow.length === 0) return true;
      const target = resolvePath(cwd);
      return allow.some((base) => {
        const b = resolvePath(base);
        // 用平台分隔符判断子目录归属：Windows 上 resolvePath 返回反斜杠路径，
        // 写死 "/" 会导致除完全相等外的子目录一律匹配失败，白名单形同虚设。
        return target === b || target.startsWith(`${b}${pathSep}`);
      });
    },
  };

  const relay = new RelayLink(config.relayUrl, config.daemonId, {
    log,
    onStatus(connected) {
      emit({ event: "relay", connected });
      // relay 断开期间客户端的 {t:"close"} 帧收不到：不清理的话，断线时离开的客户端
      // 会话会永久滞留（假在线撑着防睡眠、抑制"任务完成"通知、虚高观众计数）。
      // 就地全清——重连后 relay 会为仍在线的客户端补发 open 重建，语义不变。
      if (!connected && sessions.size > 0) {
        const n = sessions.size;
        for (const session of sessions.values()) session.dispose();
        sessions.clear();
        log(`relay 断开，清理 ${n} 个客户端会话（重连后由 open 补发重建）`);
        emit({ event: "clients", count: 0 });
      }
    },
    onOpen(cid) {
      sessions.get(cid)?.dispose(); // relay 重连补发 open 时清掉旧会话状态
      sessions.set(
        cid,
        new ClientSession(cid, daemonContext, {
          send: (data) => relay.send(cid, data),
          close: () => {
            relay.closeClient(cid);
            sessions.get(cid)?.dispose();
            sessions.delete(cid);
          },
        }),
      );
      log(`client 接入: ${cid}（当前 ${sessions.size} 个连接）`);
      emit({ event: "clients", count: sessions.size });
    },
    onMessage(cid, data) {
      sessions.get(cid)?.onEnvelope(data);
    },
    onClose(cid) {
      sessions.get(cid)?.dispose();
      sessions.delete(cid);
      log(`client 断开: ${cid}`);
      emit({ event: "clients", count: sessions.size });
    },
  });
  relay.start();
  scheduleViewerStatusWrite(); // 启动即写：清掉异常退出残留的观众计数

  // 撤销/过期即踢：配置文件变更（桌面撤销走独立 CLI 进程写盘）与 60s 定时器
  // （覆盖 expiresAt 到期）双路触发设备表核对。
  const enforce = () =>
    enforceDevices({
      configPath,
      listConnections: () => sessions.values(),
      onConfig: (fresh) => {
        daemonContext.config = fresh;
        // 通知渠道热加载：Notifier 持有的是启动时的旧数组，配置换新后须重建，
        // 否则「通知设置」里增删的渠道要等 daemon 重启才生效。
        notifier = new Notifier(fresh.notifiers ?? [], { log });
        // 战报对账：桌面端撤销/到期时观众可能早已离线，onKicked 踢不到人；
        // 以「配置中仍存在且未过期的 viewer」为准，孤儿统计也交出战报
        const valid = new Set(
          (fresh.devices ?? [])
            .filter((d) => isViewerDevice(d) && !isDeviceExpired(d))
            .map((d) => d.deviceId),
        );
        for (const h of Object.values(hubs)) h.reconcileLinks(valid);
      },
      // 围观链接被撤销/过期踢断时交出战报（幂等：首个被踢观众触发，其余空转）
      onKicked: (session) => {
        if (session.isViewer) hubs[session.scopeAgent ?? "codex"]?.finishLink(session.deviceId);
      },
      log,
    });
  const configWatcher = watchConfig(configPath, { onChange: enforce });
  const expiryTimer = setInterval(enforce, 60_000);
  expiryTimer.unref?.();

  log(`daemon 已启动: id=${config.daemonId} name=${config.daemonName}`);

  // 设备表脱敏视图（供壳 UI；不含 tokenHash 等敏感字段）
  function deviceView() {
    return (daemonContext.config.devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      name: d.name || "",
      role: d.role ?? "full",
      createdAt: d.createdAt ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      expiresAt: d.expiresAt ?? null,
    }));
  }

  emit({
    event: "ready",
    daemonId: config.daemonId,
    daemonName: config.daemonName,
    relayUrl: config.relayUrl,
    webUrl: config.webUrl,
  });
  // 显式补发初始引擎状态：app-server 在 start() 内部就绪时触发的 onStateChange(true)
  // 早于上面 onStateChange 处理器的赋值而被吞掉，若不补发，壳在引擎正常时永远收不到
  // engine:true（只有崩溃重连才有后续事件）。start() 已成功即意味着引擎健康。
  emit({ event: "engine", healthy: appServer.healthy });
  emit({ event: "devices", devices: deviceView() });

  return {
    // 运行中签发一次性配对链接（5 分钟有效、单次）。壳据此渲染二维码。
    pair() {
      const token = issuePairToken(configPath, daemonContext.config);
      const url = pairUrl(daemonContext.config, token);
      const expiresAt = Date.now() + PAIR_TOKEN_TTL_MS;
      emit({ event: "pairing", url, expiresAt });
      return { url, expiresAt };
    },
    listDevices() {
      const devices = deviceView();
      emit({ event: "devices", devices });
      return devices;
    },
    // 撤销一台设备：从配置移除并落盘（配置监听会触发 enforce 踢线），同时即时踢断在线连接。
    revoke(deviceId) {
      const before = daemonContext.config.devices?.length ?? 0;
      daemonContext.config.devices = (daemonContext.config.devices ?? []).filter(
        (d) => d.deviceId !== deviceId,
      );
      const removed = before - daemonContext.config.devices.length;
      if (removed > 0) {
        saveConfig(configPath, daemonContext.config);
        daemonContext.kickDevice(deviceId);
      }
      const devices = deviceView();
      emit({ event: "devices", devices });
      return { removed };
    },
    stop() {
      configWatcher.close();
      clearInterval(expiryTimer);
      relay.stop();
      for (const backend of Object.values(backends)) backend.stop();
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
      power.release();
    },
  };
}

const NOTIFY_USAGE = `通知渠道管理：
  notify --list                       列出已配置渠道
  notify --add bark --key <key>       添加 Bark（iOS，可加 --server 自托管地址）
  notify --add serverchan --key <key> 添加 Server 酱（微信）
  notify --add wecom --url <url>      添加企业微信群机器人
  notify --add dingtalk --url <url>   添加钉钉群机器人
  notify --add custom --url <url>     添加自定义 webhook
  notify --remove <index>             删除第 N 个渠道
  notify --clear                      清空所有渠道
  notify --test                       向所有渠道发测试通知`;

async function notifyCommand(configPath, values) {
  const config = loadOrCreateConfig(configPath);
  config.notifiers = config.notifiers ?? [];

  if (values.list || (!values.add && !values.remove && !values.clear && !values.test)) {
    if (config.notifiers.length === 0) console.log("尚未配置任何通知渠道。\n");
    else config.notifiers.forEach((n, i) => console.log(`  [${i}] ${redact(n)}`));
    if (!values.list) console.log(`\n${NOTIFY_USAGE}`);
    return;
  }
  if (values.clear) {
    config.notifiers = [];
    saveConfig(configPath, config);
    console.log("已清空所有通知渠道。");
    return;
  }
  if (values.remove !== undefined) {
    const i = Number(values.remove);
    if (!Number.isInteger(i) || i < 0 || i >= config.notifiers.length) {
      console.error("index 越界。用 notify --list 查看。");
      process.exit(1);
    }
    const [removed] = config.notifiers.splice(i, 1);
    saveConfig(configPath, config);
    console.log(`已删除 ${redact(removed)}`);
    return;
  }
  if (values.add) {
    const type = values.add;
    const needKey = ["bark", "serverchan"];
    const needUrl = ["wecom", "dingtalk", "custom"];
    let entry;
    if (needKey.includes(type)) {
      if (!values.key) { console.error(`${type} 需要 --key`); process.exit(1); }
      entry = { type, key: values.key };
      if (type === "bark" && values.server) entry.server = values.server;
    } else if (needUrl.includes(type)) {
      if (!values.url) { console.error(`${type} 需要 --url`); process.exit(1); }
      entry = { type, url: values.url };
    } else {
      console.error(`未知渠道类型: ${type}\n\n${NOTIFY_USAGE}`);
      process.exit(1);
    }
    config.notifiers.push(normalizeNotifier(entry));
    saveConfig(configPath, config);
    console.log(`已添加 ${redact(entry)}（当前 ${config.notifiers.length} 个渠道）`);
    return;
  }
  if (values.test) {
    const notifier = new Notifier(config.notifiers, { log: (m) => console.log(m) });
    if (notifier.count === 0) { console.error("尚未配置通知渠道。"); process.exit(1); }
    console.log(`向 ${notifier.count} 个渠道发送测试通知…`);
    await notifier.send("Codex 远程测试", "如果你收到这条，说明通知渠道配置成功 ✅");
    console.log("已发送（请检查手机是否收到）。");
  }
}

// 壳 IPC：逐行读 stdin 的 JSON 命令并分发到运行中的 daemon 控制器。
// 命令：{cmd:"pair"} | {cmd:"list-devices"} | {cmd:"revoke",deviceId} | {cmd:"stop"}
// 每条命令的结果通过 daemon 的 emit 以事件形式回流（pair→pairing、revoke/list→devices）。
// stdin 关闭（壳退出/被杀）即视为终止信号，优雅关停 daemon。
function startIpcStdin(daemon, shutdown) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      emitEvent({ event: "error", message: `无法解析命令: ${line.slice(0, 80)}` });
      return;
    }
    try {
      switch (msg.cmd) {
        case "pair":
          daemon.pair();
          break;
        case "list-devices":
          daemon.listDevices();
          break;
        case "revoke":
          if (!msg.deviceId) emitEvent({ event: "error", message: "revoke 缺少 deviceId" });
          else daemon.revoke(msg.deviceId);
          break;
        case "stop":
          shutdown();
          break;
        default:
          emitEvent({ event: "error", message: `未知命令: ${msg.cmd}` });
      }
    } catch (err) {
      emitEvent({ event: "error", message: `命令 ${msg.cmd} 执行失败: ${err.message}` });
    }
  });
  rl.on("close", shutdown);
}

export async function main() {
  // PreToolUse approval hook mode: Claude Code spawns THIS binary (env-flagged) per gated
  // tool use. Dispatch early — before any daemon setup — and exit. Works in dev (node
  // running source) and SEA (single binary) alike, since it keys off the environment, not
  // an on-disk sibling script. See claude-backend.mjs / claude-perm-hook.mjs.
  if (process.env.CXX_PERM_HOOK === "1") {
    const { runPermHook } = await import("./claude-perm-hook.mjs");
    await runPermHook(process.env.CXX_APPROVE_URL, process.env.CXX_APPROVE_TOKEN);
    return;
  }
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      relay: { type: "string" },
      web: { type: "string" },
      codex: { type: "string" },
      claude: { type: "string" }, // 覆盖 claude 二进制路径（缺省自动探测）
      ipc: { type: "boolean" }, // 壳模式：stdout JSON 事件流 + stdin JSON 命令
      "prevent-sleep": { type: "boolean" }, // --no-prevent-sleep 关闭防睡眠
      // notify 命令选项
      list: { type: "boolean" },
      add: { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      server: { type: "string" },
      remove: { type: "string" },
      clear: { type: "boolean" },
      test: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "start";
  const configPath = values.config ?? defaultConfigPath();

  // 桌面壳的 per-action 后端（Model A）：argv 子命令进 → 单行 JSON 出。
  // enable/disable 走平台 keepalive（macOS launchd / Windows 计划任务）；其余读改 config，运行中的 daemon 靠
  // config-watch 热核对。stdout 必须是纯 JSON，日志改走 stderr。
  if (MENU_COMMANDS.has(command)) {
    const deps = makeMenuDeps({ configPath });
    const result = await runMenuCommand(command, positionals.slice(1), deps);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "notify") {
    await notifyCommand(configPath, values);
    return;
  }
  if (command === "start") {
    ipcMode = values.ipc === true;
    const emit = ipcMode ? emitEvent : () => {};
    let daemon;
    try {
      daemon = await startDaemon({
        configPath,
        overrides: {
          relayUrl: values.relay,
          webUrl: values.web,
          codexCommand: values.codex,
          claudeCommand: values.claude,
          preventSleep: values["prevent-sleep"], // undefined 时保持配置默认；--no-prevent-sleep => false
        },
        emit,
      });
    } catch (err) {
      // IPC 模式把启动失败也结构化上报，便于壳展示（否则壳只能靠退出码猜）
      if (ipcMode) emitEvent({ event: "error", message: err.message });
      throw err;
    }
    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (ipcMode) startIpcStdin(daemon, shutdown);
    return;
  }
  console.error(`未知命令: ${command}（支持 start / pair / notify）`);
  process.exit(1);
}

// 入口判定：比较 import.meta.url 与 argv[1] 的 file:// URL。
// 不能用 split("/") 取文件名——Windows 路径是反斜杠，切不出来会导致判定恒为 false，
// 于是 main() 永不执行、进程静默退出 0（Windows 上 daemon「跑了但什么都没发生」的根因）。
// SEA 打包时 entry.mjs 会显式调用 main() 并置此哨兵，避免与下方自动运行判定重复触发。
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun && !globalThis.__CXX_ENTRY__) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
