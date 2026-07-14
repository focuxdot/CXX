// Terminal Mode 的 daemon 核心（internal/TERMINAL-MODE.md §5/§6/§8/§10/§12）。
//
// 职责：TerminalSession 状态机与列表、单 owner 控制权、preset 注册表、
// headless xterm 快照（含分片）、输出 coalesce 与 daemon 侧增量 ring、
// bell/退出/静默超时事件上抛（通知闭环由 main.mjs 接 Notifier）。
//
// 会话真相在 pty-host（独立进程，daemon 重启不死）；本类持有的是视图，
// daemon 启动时经 restore() 扫描注册目录重建。鉴权/角色检查在 ClientSession 层，
// 这里只认 deviceId/deviceName。
import { existsSync, statSync } from "node:fs";
import { join, basename, delimiter } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

import { randomId } from "./crypto.mjs";
import {
  spawnPtyHost,
  reattachPtyHost,
  listPtyHosts,
  removePtyHostDir,
} from "./pty-adapter.mjs";
import { captureShellEnv } from "./shell-env.mjs";

const require = createRequire(import.meta.url);

// —— 常量（起点值，§17 基准后校准）——
const MAX_TERMINALS = 8; // 同时运行上限（host 进程数）
const MAX_EXITED_KEEP = 10; // 退出终端最多保留条数
const EXITED_KEEP_MS = 24 * 3600_000; // 退出终端保留时长
const COALESCE_MS = 16; // 输出合帧窗口
const COALESCE_BYTES = 32 * 1024; // 输出合帧字节阈值
const RING_BYTES = 256 * 1024; // daemon 侧增量 ring（attach 断点续传用）
const SCROLLBACK = 1000; // headless 回滚行数
const SNAPSHOT_SCROLLBACK = 200; // 快照序列化的回滚行数（控制体积）
// 分片按"信封最终字节"预算，不按字符数：快照是 JS 字符串（JSON 转义 + UTF-8），
// output 的 data 是 base64。seal 最终 = byteLength(JSON.stringify(frame)) × 4/3 + 开销。
// 目标最终帧 ≲ 230KiB（稳过 relay 256KiB）：快照按转义字节 150KiB、output 按裸字节 100KiB。
const SNAPSHOT_MAX_ESCAPED_BYTES = 150 * 1024;
const OUTPUT_MAX_RAW_BYTES = 100 * 1024;
const BELL_WINDOW_MS = 60_000; // 同终端响铃通知合并窗口
const SILENCE_MS = 5 * 60_000; // 静默超时（Agent preset 默认开）
const SWEEP_MS = 30_000; // 静默检测/活跃广播的扫描间隔
const INPUT_MAX_CHARS = 32_000;
const REATTACH_TRIES = 3; // 意外断连的重连尝试

// —— preset 注册表（§8）——
// 内置候选；实际显示取决于登录 shell PATH 下的检测结果。Shell 永远存在。
const PRESET_CANDIDATES = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    args: [],
    defaultInputMode: "instruction",
    // auto-accept 模式切换是 Claude 的高频操作（§4.5）
    quickKeys: [{ label: "⇧Tab", seq: "\x1b[Z" }],
    silenceNotify: true,
  },
  { id: "opencode", name: "OpenCode", bin: "opencode", args: [], defaultInputMode: "instruction", quickKeys: [], silenceNotify: true },
  { id: "codex", name: "Codex CLI", bin: "codex", args: [], defaultInputMode: "instruction", quickKeys: [], silenceNotify: true },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", args: [], defaultInputMode: "instruction", quickKeys: [], silenceNotify: true },
];

// 在给定 PATH 中找可执行文件的绝对路径（登录 shell env 的 PATH，见 shell-env.mjs）
function findInPath(bin, pathValue) {
  if (!pathValue) return null;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// 单字符在 JSON.stringify 后占的字节数（UTF-8 + JSON 转义）：控制字符 → \uXXXX(6)
// 或短转义(2)，" \ → 2，ASCII → 1，其余按 UTF-8 编码长度。用于按"信封最终字节"而非
// 字符数给快照分片——CJK 满屏或密集 truecolor TUI 用字符数会严重低估、把帧撑破 256KiB。
function escapedByteCost(cp) {
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp < 0x20) return (cp === 8 || cp === 9 || cp === 10 || cp === 12 || cp === 13) ? 2 : 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

// 按转义字节预算切字符串（for...of 按码点迭代，绝不劈开代理对）。空串返回 [""]，
// 保证至少一个分片（客户端据 part 0 起装配）。
function splitByEscapedBytes(str, maxBytes) {
  const parts = [];
  let cur = "";
  let cost = 0;
  for (const ch of str) {
    const c = escapedByteCost(ch.codePointAt(0));
    if (cost + c > maxBytes && cur.length > 0) {
      parts.push(cur);
      cur = "";
      cost = 0;
    }
    cur += ch;
    cost += c;
  }
  parts.push(cur);
  return parts;
}

const clampCols = (n) => Math.max(20, Math.min(500, n));
const clampRows = (n) => Math.max(5, Math.min(300, n));

function defaultShell(env) {
  if (process.platform === "win32") {
    return { executable: findInPath("powershell", env.PATH) ?? "powershell.exe", args: ["-NoLogo"] };
  }
  const sh = env.SHELL && existsSync(env.SHELL) ? env.SHELL : "/bin/sh";
  return { executable: sh, args: ["-l"] };
}

export class TerminalManager {
  #hostBin;
  #baseDir;
  #log;
  #isCwdAllowed;
  #onEvent; // (type, payload) => void  —— bell / exited / silence（main 接 Notifier）
  #broadcast; // (method, params) => void —— terminal.listChanged 等广播（main 遍历连接）
  #adapter; // { spawnPtyHost, reattachPtyHost, listPtyHosts, removePtyHostDir }（测试可注入 fake）
  #getEnv; // () => Promise<env>
  #xterm = null; // { Terminal, SerializeAddon }，懒加载
  #sessions = new Map(); // terminalId -> session
  #pendingCreates = 0; // 在途 create（插入 map 前的同步窗口）计数，供上限判定
  #presets = null; // 检测结果缓存
  #recentCwds = []; // 最近使用目录（本进程内记忆）
  #sweepTimer = null;
  #activityDirty = false; // lastOutputAt 有更新，下次扫描时广播节流的 listChanged
  #stopped = false;

  constructor({ hostBin, baseDir, log = () => {}, isCwdAllowed = () => true, onEvent = () => {}, broadcast = () => {}, adapter, getEnv, xterm }) {
    this.#hostBin = hostBin;
    this.#baseDir = baseDir;
    this.#log = log;
    this.#isCwdAllowed = isCwdAllowed;
    this.#onEvent = onEvent;
    this.#broadcast = broadcast;
    this.#adapter = adapter ?? { spawnPtyHost, reattachPtyHost, listPtyHosts, removePtyHostDir };
    this.#getEnv = getEnv ?? captureShellEnv;
    if (xterm) this.#xterm = xterm;
    this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_MS);
    this.#sweepTimer.unref?.();
  }

  get available() {
    return Boolean(this.#hostBin && existsSync(this.#hostBin));
  }

  #loadXterm() {
    if (!this.#xterm) {
      const { Terminal, SerializeAddon } = require("./vendor/xterm-headless.cjs");
      this.#xterm = { Terminal, SerializeAddon };
    }
    return this.#xterm;
  }

  // —— preset ——
  async presets() {
    if (!this.#presets) {
      const env = await this.#getEnv();
      const found = [];
      for (const c of PRESET_CANDIDATES) {
        const abs = findInPath(c.bin, env.PATH);
        if (abs) found.push({ ...c, executable: abs });
      }
      const sh = defaultShell(env);
      found.push({
        id: "shell",
        name: "Shell",
        executable: sh.executable,
        args: sh.args,
        defaultInputMode: "keyboard",
        quickKeys: [],
        silenceNotify: false, // Shell preset 默认关（§12.1）
      });
      this.#presets = found;
    }
    return this.#presets.map(({ bin, ...p }) => p);
  }

  async presetById(id) {
    return (await this.presets()).find((p) => p.id === id) ?? null;
  }

  recentCwds() {
    return [...this.#recentCwds];
  }

  // —— 会话视图 ——
  #view(s) {
    return {
      terminalId: s.id,
      generation: s.generation,
      title: s.title,
      presetId: s.presetId,
      presetName: s.presetName,
      cwd: s.cwd,
      status: s.status,
      cols: s.cols,
      rows: s.rows,
      ownerDeviceId: s.ownerDeviceId,
      ownerDeviceName: s.ownerDeviceName,
      lastOutputAt: s.lastOutputAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
    };
  }

  list() {
    return [...this.#sessions.values()].map((s) => this.#view(s));
  }

  get(terminalId) {
    return this.#sessions.get(terminalId) ?? null;
  }

  #touch(s) {
    s.updatedAt = Date.now();
  }

  #emitListChanged() {
    this.#broadcast("terminal.listChanged", { terminals: this.list() });
  }

  // —— 创建 ——
  async create({ presetId, cwd, cols, rows, deviceId, deviceName }) {
    // 上限判定与占位在 await 之前的同步窗口里做：#pendingCreates 覆盖插入 map 之前的
    // 在途创建，否则 N 个并发 create 都在插入前通过检查、冲破 MAX_TERMINALS（无界拉起 host）
    const active = [...this.#sessions.values()].filter((s) => s.status === "RUNNING" || s.status === "DETACHED" || s.status === "CREATING").length;
    if (active + this.#pendingCreates >= MAX_TERMINALS) {
      throw Object.assign(new Error(`同时运行的终端已达上限（${MAX_TERMINALS}）`), { code: 429 });
    }
    this.#pendingCreates++;
    try {
      return await this.#doCreate({ presetId, cwd, cols, rows, deviceId, deviceName });
    } finally {
      this.#pendingCreates--;
    }
  }

  async #doCreate({ presetId, cwd, cols, rows, deviceId, deviceName }) {
    const preset = (await this.presets(), this.#presets.find((p) => p.id === presetId));
    if (!preset) throw Object.assign(new Error(`未知启动方式: ${presetId}`), { code: 400 });
    if (preset.id !== "shell" && !existsSync(preset.executable)) {
      throw Object.assign(new Error(`未找到 ${preset.name}，请在电脑上确认安装`), { code: 404 });
    }
    if (typeof cwd !== "string" || !cwd) throw Object.assign(new Error("缺少工作目录"), { code: 400 });
    let st;
    try {
      st = statSync(cwd);
    } catch {
      throw Object.assign(new Error("工作目录不可用，请重新选择"), { code: 400 });
    }
    if (!st.isDirectory()) throw Object.assign(new Error("工作目录不可用，请重新选择"), { code: 400 });
    if (!this.#isCwdAllowed(cwd)) throw Object.assign(new Error("该目录不在允许列表中"), { code: 403 });

    const c = Math.max(20, Math.min(500, Number(cols) || 80));
    const r = Math.max(5, Math.min(300, Number(rows) || 24));
    const id = `t${randomId(8)}`;
    const now = Date.now();
    const session = {
      id,
      generation: `g${randomId(4)}`,
      title: `${preset.name} · ${basename(cwd)}`,
      presetId: preset.id,
      presetName: preset.name,
      cwd,
      status: "CREATING",
      cols: c,
      rows: r,
      ownerDeviceId: deviceId ?? null,
      ownerDeviceName: deviceName ?? "",
      outputSeq: 0,
      lastOutputAt: now,
      createdAt: now,
      updatedAt: now,
      exitCode: null,
      exitSignal: null,
      silenceNotify: preset.silenceNotify === true,
      dir: join(this.#baseDir, id),
      client: null,
      term: null,
      serializer: null,
      watchers: new Map(), // sink(ClientSession) -> { deviceId }
      ring: [], // [{seq, buf}] 尾部增量（RING_BYTES 预算）
      ringBytes: 0,
      pending: [], // 输出合帧缓冲
      pendingBytes: 0,
      pendingSeq: 0,
      flushTimer: null,
      lastBellAt: 0,
      silenceFiredFor: -1,
      closeRequestedAt: 0,
      reattaching: false,
    };
    this.#sessions.set(id, session);
    const env = await this.#getEnv();
    const spec = {
      executable: preset.executable,
      args: preset.args,
      cwd,
      env,
      cols: c,
      rows: r,
      meta: {
        title: session.title,
        presetId: preset.id,
        presetName: preset.name,
        cwd,
        createdAt: now,
        silenceNotify: session.silenceNotify,
      },
    };
    try {
      const { client, hello } = await this.#adapter.spawnPtyHost({ hostBin: this.#hostBin, dir: session.dir, spec });
      this.#attachHostClient(session, client, hello);
      session.status = "RUNNING";
    } catch (err) {
      session.status = "FAILED";
      this.#touch(session);
      try {
        this.#adapter.removePtyHostDir(session.dir);
      } catch {}
      this.#log(`terminal ${id} 启动失败: ${err.message}`);
      this.#emitListChanged();
      this.#pruneExited(); // FAILED 会话也纳入回收，反复失败创建不会无限堆积
      throw Object.assign(new Error(`终端启动失败: ${err.message.split("\n")[0]}`), { code: 500 });
    }
    // CREATING 期间收到 close：spawn 已在途，就绪即结束，不覆盖成 RUNNING（否则用户
    // 已请求关闭却看着它照常启动）
    if (session.closeOnReady) {
      session.closeRequestedAt = Date.now();
      session.status = "STOPPING";
      this.#touch(session);
      try {
        session.client.close();
      } catch {}
      this.#emitListChanged();
      return this.#view(session);
    }
    this.#touch(session);
    this.#recentCwds = [cwd, ...this.#recentCwds.filter((x) => x !== cwd)].slice(0, 8);
    this.#emitListChanged();
    return this.#view(session);
  }

  // —— host 连接事件接线（create 与 restore/重连共用）——
  #attachHostClient(session, client, hello) {
    session.client = client;
    if (!session.term) {
      const { Terminal, SerializeAddon } = this.#loadXterm();
      session.term = new Terminal({
        cols: hello.cols || session.cols,
        rows: hello.rows || session.rows,
        scrollback: SCROLLBACK,
        allowProposedApi: true,
      });
      session.serializer = new SerializeAddon();
      session.term.loadAddon(session.serializer);
      session.term.onBell(() => this.#onBell(session));
    }
    session.cols = hello.cols || session.cols;
    session.rows = hello.rows || session.rows;
    client.on("data", (seq, buf) => this.#onOutput(session, seq, buf));
    client.on("replayEnd", (r) => this.#onReplayEnd(session, r));
    client.on("exit", (e) => this.#onExit(session, e));
    client.on("close", () => this.#onHostClose(session, client));
    client.on("error", () => {}); // close 事件统一善后
  }

  // 中段重连的 ring 重放收尾：只在 #onHostClose 设了 replayExpectSeq 时关心 gap
  //（create/restore 的首次 attach 本就从头重建，gap 是预期的，不在此处理）。
  #onReplayEnd(session, r) {
    const expect = session.replayExpectSeq;
    session.replayExpectSeq = null;
    if (expect == null) return;
    if (!r.gap && (r.from ?? 0) <= expect) return; // 无缝续传
    // 缺口：host ring 未覆盖断线期间的输出，中间流已带洞写进 headless（视区通常仍能
    // 靠 TUI 重绘收敛，但 daemon 增量 ring 已不连续）。清 ring、翻代、令所有 watcher
    // 重新 attach 拿快照，并抖动尺寸促使全屏 TUI 全量重绘（§7.3 尽力恢复）。
    session.ring = [];
    session.ringBytes = 0;
    session.generation = `g${randomId(4)}`;
    for (const sink of session.watchers.keys()) {
      sink.pushTerminal("terminal.resyncRequired", { terminalId: session.id, generation: session.generation });
    }
    this.#nudgeResize(session);
  }

  // cols±1 再复原：促使全屏 TUI 全量重绘（重放的中间流可能不完整）
  #nudgeResize(session) {
    const { cols, rows } = session;
    if (!session.client) return;
    try {
      session.client.resize(cols + 1, rows);
      setTimeout(() => {
        try {
          session.client?.resize(cols, rows);
        } catch {}
      }, 150).unref?.();
    } catch {}
  }

  #onOutput(session, seq, buf) {
    session.term.write(buf);
    if (session.pending.length === 0) session.pendingSeq = seq;
    session.pending.push(buf);
    session.pendingBytes += buf.length;
    session.outputSeq = seq + buf.length;
    session.lastOutputAt = Date.now();
    this.#activityDirty = true;
    if (session.pendingBytes >= COALESCE_BYTES) this.#flushOutput(session);
    else if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.#flushOutput(session), COALESCE_MS);
      session.flushTimer.unref?.();
    }
  }

  #flushOutput(session) {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending.length === 0) return;
    const buf = session.pending.length === 1 ? session.pending[0] : Buffer.concat(session.pending);
    const seq = session.pendingSeq;
    session.pending = [];
    session.pendingBytes = 0;
    // daemon 侧尾部 ring：attach 带 haveSeq 命中时走增量，避免整屏快照
    session.ring.push({ seq, buf });
    session.ringBytes += buf.length;
    while (session.ringBytes > RING_BYTES && session.ring.length > 1) {
      session.ringBytes -= session.ring.shift().buf.length;
    }
    const params = {
      terminalId: session.id,
      generation: session.generation,
      seq,
      data: buf.toString("base64"),
    };
    for (const sink of session.watchers.keys()) {
      sink.pushTerminal("terminal.output", params, { low: true });
    }
  }

  #onBell(session) {
    const now = Date.now();
    if (now - session.lastBellAt < BELL_WINDOW_MS) return;
    session.lastBellAt = now;
    this.#onEvent("bell", { terminalId: session.id, title: session.title });
  }

  #onExit(session, e) {
    if (session.status === "EXITED") return;
    session.status = "EXITED";
    session.exitCode = e.code ?? null;
    session.exitSignal = e.signal ?? null;
    this.#touch(session);
    this.#flushOutput(session);
    const selfClose = session.closeRequestedAt > 0 && Date.now() - session.closeRequestedAt < 60_000;
    for (const sink of session.watchers.keys()) {
      sink.pushTerminal("terminal.exited", {
        terminalId: session.id,
        generation: session.generation,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        exitedAt: session.updatedAt,
      });
    }
    if (!selfClose) {
      this.#onEvent("exited", {
        terminalId: session.id,
        title: session.title,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
      });
    }
    this.#emitListChanged();
    this.#pruneExited();
  }

  // host 连接断开：child 未退出时先尝试重连（host 停滞踢连/瞬时故障），
  // 重连失败才判 host 崩溃 → EXITED(异常)。
  async #onHostClose(session, client) {
    if (session.client !== client) return; // 已被新连接顶替
    if (this.#stopped || session.status === "EXITED" || session.status === "FAILED") return;
    if (session.reattaching) return;
    session.reattaching = true;
    try {
      for (let i = 0; i < REATTACH_TRIES; i++) {
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        if (this.#stopped || session.status === "EXITED") return;
        try {
          // 记下重连前的期望续传点：replayEnd 据此判断 ring 是否覆盖断线期间的输出
          session.replayExpectSeq = session.outputSeq;
          const { client: fresh, hello } = await this.#adapter.reattachPtyHost({
            dir: session.dir,
            sinceSeq: session.outputSeq,
            timeoutMs: 2000,
          });
          this.#attachHostClient(session, fresh, hello);
          if (hello.exited) {
            this.#onExit(session, { code: hello.exitCode, signal: hello.exitSignal });
          }
          this.#log(`terminal ${session.id} host 连接已恢复`);
          return;
        } catch {}
      }
      // 重连失败：host 进程消失，按异常结束处理
      this.#log(`terminal ${session.id} host 连接丢失且无法恢复，标记异常结束`);
      this.#onExit(session, { code: null, signal: "host-lost" });
    } finally {
      session.reattaching = false;
    }
  }

  // —— attach / detach（sink = ClientSession，须实现 pushTerminal(method, params, opts?)）——
  attach(sink, { terminalId, generation, haveSeq, cols, rows, deviceId }) {
    const s = this.#requireSession(terminalId);
    s.watchers.set(sink, { deviceId });
    // owner 首次 attach 且尺寸不同 → 应用 owner 的尺寸（终端只有一个真实尺寸，§4.7）。
    // 必须夹取：未经校验的巨值会让 xterm 分配天量单元格 → daemon OOM 崩溃（连累全部会话）
    if (deviceId && deviceId === s.ownerDeviceId && s.status !== "EXITED" && s.client &&
        Number.isInteger(cols) && Number.isInteger(rows)) {
      const cc = clampCols(cols);
      const rr = clampRows(rows);
      if (cc !== s.cols || rr !== s.rows) this.#applyResize(s, cc, rr);
    }
    // 增量续传：同代 且 haveSeq 落在 daemon ring 覆盖范围内
    const ringStart = s.ring.length ? s.ring[0].seq : s.outputSeq;
    if (
      generation === s.generation &&
      Number.isInteger(haveSeq) &&
      haveSeq >= ringStart &&
      haveSeq <= s.outputSeq
    ) {
      // 从 ring 里拼出 [haveSeq, outputSeq) 的字节，一次性以 output 帧补发
      const parts = [];
      for (const { seq, buf } of s.ring) {
        const end = seq + buf.length;
        if (end <= haveSeq) continue;
        parts.push(seq >= haveSeq ? buf : buf.subarray(haveSeq - seq));
      }
      const delta = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
      // 分片：整段 ring 拼成一帧会超 256KiB 帧上限（重连于 ring 尾部时最坏 ~256KiB
      // 原始字节 → base64 → 信封膨胀远超上限），按裸字节切多帧，seq 是字节偏移故可精确切分
      for (let off = 0; off < delta.length; off += OUTPUT_MAX_RAW_BYTES) {
        const slice = delta.subarray(off, off + OUTPUT_MAX_RAW_BYTES);
        sink.pushTerminal("terminal.output", {
          terminalId: s.id,
          generation: s.generation,
          seq: haveSeq + off,
          data: slice.toString("base64"),
        }, { low: true });
      }
      return { mode: "delta", ...this.#attachInfo(s) };
    }
    // 快照路径
    this.#sendSnapshot(sink, s);
    return { mode: "snapshot", ...this.#attachInfo(s) };
  }

  #attachInfo(s) {
    return {
      terminalId: s.id,
      generation: s.generation,
      cols: s.cols,
      rows: s.rows,
      status: s.status,
      nextSeq: s.outputSeq,
      ownerDeviceId: s.ownerDeviceId,
      ownerDeviceName: s.ownerDeviceName,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
    };
  }

  #sendSnapshot(sink, s) {
    let data = "";
    if (s.serializer) {
      try {
        data = s.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK });
      } catch (err) {
        this.#log(`terminal ${s.id} 快照序列化失败: ${err.message}`);
      }
    }
    const parts = splitByEscapedBytes(data, SNAPSHOT_MAX_ESCAPED_BYTES);
    parts.forEach((part, i) => {
      sink.pushTerminal("terminal.snapshot", {
        terminalId: s.id,
        generation: s.generation,
        part: i,
        final: i === parts.length - 1,
        data: part,
        nextSeq: s.outputSeq,
        cols: s.cols,
        rows: s.rows,
      }, { low: true });
    });
  }

  detach(sink, terminalId) {
    const s = this.#sessions.get(terminalId);
    if (s) s.watchers.delete(sink);
  }

  detachAll(sink) {
    for (const s of this.#sessions.values()) s.watchers.delete(sink);
  }

  // —— 输入 / 尺寸 / 信号（owner only，owner 判定在这里做——控制权是会话状态）——
  input(terminalId, deviceId, { data, text, submit }) {
    const s = this.#requireRunning(terminalId);
    this.#requireOwner(s, deviceId);
    if (typeof text === "string") {
      if (text.length > INPUT_MAX_CHARS) throw Object.assign(new Error("输入过长"), { code: 400 });
      // 指令模式：daemon 侧跟踪 DECSET 2004——开启时包 bracketed paste 再回车，
      // 否则多行指令被 Shell 逐行执行 / 被 TUI 当成多次提交（§4.5）
      let payload = text;
      if (s.term?.modes.bracketedPasteMode) {
        payload = `\x1b[200~${text}\x1b[201~`;
      }
      if (submit) payload += "\r";
      s.client.write(payload);
      return { ok: true };
    }
    if (typeof data === "string") {
      if (data.length > INPUT_MAX_CHARS * 2) throw Object.assign(new Error("输入过长"), { code: 400 });
      s.client.write(Buffer.from(data, "base64"));
      return { ok: true };
    }
    throw Object.assign(new Error("缺少输入内容"), { code: 400 });
  }

  resize(terminalId, deviceId, cols, rows) {
    const s = this.#requireRunning(terminalId);
    this.#requireOwner(s, deviceId);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      throw Object.assign(new Error("尺寸参数非法"), { code: 400 });
    }
    this.#applyResize(s, clampCols(cols), clampRows(rows));
    return { ok: true, cols: s.cols, rows: s.rows };
  }

  #applyResize(s, cols, rows) {
    s.cols = cols;
    s.rows = rows;
    s.term?.resize(cols, rows);
    s.client?.resize(cols, rows);
    this.#touch(s);
  }

  signal(terminalId, deviceId, kind) {
    const s = this.#requireRunning(terminalId);
    this.#requireOwner(s, deviceId);
    // 协议面只暴露 interrupt/eof（§9.2）；term/kill 走 close
    if (kind !== "interrupt" && kind !== "eof") {
      throw Object.assign(new Error(`不支持的信号: ${kind}`), { code: 400 });
    }
    s.client.signal(kind);
    return { ok: true };
  }

  // —— 控制权（§4.7：显式接管，无租约）——
  takeover(terminalId, deviceId, deviceName) {
    const s = this.#requireSession(terminalId);
    if (s.ownerDeviceId === deviceId) return { ok: true, ownerDeviceId: deviceId };
    s.ownerDeviceId = deviceId;
    s.ownerDeviceName = deviceName ?? "";
    this.#touch(s);
    for (const [sink, info] of s.watchers) {
      sink.pushTerminal("terminal.controlChanged", {
        terminalId: s.id,
        ownerDeviceId: s.ownerDeviceId,
        ownerDeviceName: s.ownerDeviceName,
        youAreOwner: info.deviceId === deviceId,
      });
    }
    this.#emitListChanged();
    return { ok: true, ownerDeviceId: deviceId };
  }

  // —— 关闭（owner only）——
  close(terminalId, deviceId) {
    const s = this.#requireSession(terminalId);
    if (s.status === "EXITED" || s.status === "FAILED") {
      // 已结束的终端：close = 从列表移除并回收注册目录
      this.#disposeSession(s);
      this.#emitListChanged();
      return { ok: true, removed: true };
    }
    this.#requireOwner(s, deviceId);
    s.closeRequestedAt = Date.now(); // 自发起关闭不推退出通知（§12.2）
    // CREATING 期间还没有 client：标记就绪即关，由 #doCreate 收尾（不能在此 s.client.close()）
    if (!s.client) {
      s.closeOnReady = true;
      return { ok: true };
    }
    s.status = "STOPPING";
    this.#touch(s);
    s.client.close();
    this.#emitListChanged();
    return { ok: true };
  }

  #disposeSession(s) {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    try {
      s.client?.disconnect();
    } catch {}
    try {
      s.term?.dispose();
    } catch {}
    try {
      this.#adapter.removePtyHostDir(s.dir);
    } catch {}
    this.#sessions.delete(s.id);
  }

  // 退出终端保留有限数量/时长（§6）
  #pruneExited() {
    const exited = [...this.#sessions.values()]
      .filter((s) => s.status === "EXITED" || s.status === "FAILED")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const now = Date.now();
    for (const s of exited) {
      const over = exited.length - MAX_EXITED_KEEP;
      if (exited.indexOf(s) < over || now - s.updatedAt > EXITED_KEEP_MS) {
        this.#disposeSession(s);
      }
    }
  }

  // —— daemon 重启恢复（§7.3）——
  async restore() {
    let found;
    try {
      found = this.#adapter.listPtyHosts(this.#baseDir);
    } catch {
      return;
    }
    for (const h of found) {
      if (this.#stopped) return; // stop() 与在途 restore 竞争：别把已清空的 map 重新填满
      if (this.#sessions.has(h.terminalId)) continue;
      const meta = h.meta ?? {};
      const now = Date.now();
      const session = {
        id: h.terminalId,
        generation: `g${randomId(4)}`, // 新代次：旧客户端的 attach/seq 全部作废
        title: meta.title ?? h.terminalId,
        presetId: meta.presetId ?? "shell",
        presetName: meta.presetName ?? "Shell",
        cwd: meta.cwd ?? "",
        status: h.alive ? "DETACHED" : "EXITED",
        cols: 80,
        rows: 24,
        ownerDeviceId: null, // daemon 重启后控制权清零，首个接管者取得
        ownerDeviceName: "",
        outputSeq: 0,
        lastOutputAt: now,
        createdAt: meta.createdAt ?? h.startedAt ?? now,
        updatedAt: now,
        exitCode: h.exit?.code ?? null,
        exitSignal: h.exit?.signal ?? null,
        silenceNotify: meta.silenceNotify === true,
        dir: h.dir,
        client: null,
        term: null,
        serializer: null,
        watchers: new Map(),
        ring: [],
        ringBytes: 0,
        pending: [],
        pendingBytes: 0,
        pendingSeq: 0,
        flushTimer: null,
        lastBellAt: 0,
        silenceFiredFor: -1,
        closeRequestedAt: 0,
        reattaching: false,
      };
      if (!h.alive) {
        // host 已死：有 exit.json 则保留退出视图（无画面），否则是残骸，直接清
        if (h.exit) {
          this.#sessions.set(session.id, session);
        } else {
          try {
            this.#adapter.removePtyHostDir(h.dir);
          } catch {}
        }
        continue;
      }
      try {
        // sinceSeq=0：全量 ring 重放进新 headless，恢复画面
        const { client, hello } = await this.#adapter.reattachPtyHost({ dir: h.dir, sinceSeq: 0 });
        this.#sessions.set(session.id, session);
        this.#attachHostClient(session, client, hello);
        session.outputSeq = hello.ringStart ?? 0;
        if (hello.exited) {
          session.status = "EXITED";
          session.exitCode = hello.exitCode;
          session.exitSignal = hello.exitSignal;
        } else {
          session.cols = hello.cols || 80;
          session.rows = hello.rows || 24;
          setTimeout(() => {
            if (session.status === "DETACHED" || session.status === "RUNNING") this.#nudgeResize(session);
          }, 500).unref?.();
        }
        this.#log(`terminal ${session.id} 已恢复（${session.title}）`);
      } catch (err) {
        // 重连失败（host 已死但 pidAlive 误判存活/PID 复用/socket 陈旧）：清残骸，
        // 否则每次 daemon 重启都会为它再花一次串行 reattach 超时，累积拖慢启动
        this.#log(`terminal ${h.terminalId} 恢复失败，清理注册目录: ${err.message}`);
        try {
          this.#adapter.removePtyHostDir(h.dir);
        } catch {}
      }
    }
    this.#pruneExited();
    if (this.#sessions.size) this.#emitListChanged();
  }

  // —— 静默超时 + 活跃度广播（§12.1：字节级 lastOutputAt，纯时间事实）——
  #sweep() {
    const now = Date.now();
    for (const s of this.#sessions.values()) {
      if (!s.silenceNotify) continue;
      if (s.status !== "RUNNING" && s.status !== "DETACHED") continue;
      if (now - s.lastOutputAt < SILENCE_MS) continue;
      if (s.silenceFiredFor === s.lastOutputAt) continue; // 同一段静默只报一次
      s.silenceFiredFor = s.lastOutputAt;
      this.#onEvent("silence", {
        terminalId: s.id,
        title: s.title,
        silentForMs: now - s.lastOutputAt,
      });
    }
    if (this.#activityDirty) {
      this.#activityDirty = false;
      this.#emitListChanged(); // lastOutputAt 粗粒度更新（SWEEP_MS 节流）
    }
  }

  // —— 校验助手 ——
  #requireSession(terminalId) {
    const s = this.#sessions.get(terminalId);
    if (!s) throw Object.assign(new Error("终端不存在"), { code: 404 });
    return s;
  }

  #requireRunning(terminalId) {
    const s = this.#requireSession(terminalId);
    if (s.status === "EXITED" || s.status === "FAILED") {
      throw Object.assign(new Error("终端已结束"), { code: 409 });
    }
    if (!s.client) throw Object.assign(new Error("终端尚未就绪"), { code: 409 });
    return s;
  }

  #requireOwner(s, deviceId) {
    if (!deviceId || s.ownerDeviceId !== deviceId) {
      throw Object.assign(new Error("当前设备不是该终端的控制者，请先接管"), { code: 409 });
    }
  }

  // daemon 停止：断开 host 连接但不结束终端（连续性支柱）
  stop() {
    this.#stopped = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    for (const s of this.#sessions.values()) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      try {
        s.client?.disconnect();
      } catch {}
      try {
        s.term?.dispose();
      } catch {}
    }
    this.#sessions.clear();
  }
}
