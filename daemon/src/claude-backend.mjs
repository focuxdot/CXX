// Claude Code backend — implements the same surface as AppServer (app-server.mjs),
// but Claude Code has NO persistent JSON-RPC server. So:
//   - READS (list / read / history / tail) come straight off the on-disk session
//     JSONL at ~/.claude/projects/<slug>/<uuid>.jsonl — no process needed.
//   - WRITES (resume / turn / interrupt) drive the `claude -p ... --input-format
//     stream-json` headless mode, spawned per turn. (Phase 2.)
//
// The session JSONL is the Anthropic Messages API shape (one entry per line:
// {type, message:{role,content:[blocks]}, uuid, parentUuid, cwd, gitBranch, ...}),
// distinct from codex rollout. rollout-tail.mjs is format-agnostic (it only splits
// JSONL lines) so it is reused as-is; the Claude-specific interpretation of those
// raw entries lives on the web side's separate render path.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { killProcessTree, reapStalePids, writePidFile } from "./proc-reap.mjs";
import { CachedProjects, normSep } from "./project-index.mjs";
import { parseJsonlChunk } from "./rollout-tail.mjs";

// Tools gated behind approval (mutating / command execution). Read-only tools
// (Read/Grep/Glob/…) run freely so the phone isn't spammed with trivial approvals.
const GATED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];

// —— persistent write-path knobs ——
// One `claude -p --input-format stream-json` child is kept alive per thread and reused
// across turns (no cold start / MCP re-init per turn). A claude process idles at
// hundreds of MB, so idle children are reaped and a small cap bounds the fleet.
const PROC_IDLE_MS = 5 * 60_000;
const PROC_MAX = 3;
// Interrupt: try the stream-json control channel first (claude finishes the turn
// gracefully, keeping partial output); escalate to SIGTERM only if unconfirmed in time.
const INTERRUPT_GRACE_MS = 3_000;
// Typing deltas are coalesced before fanning out over the relay (each flush is one
// frame per watching device; raw token deltas would be dozens of frames per second).
const DELTA_FLUSH_MS = 150;

// The command that re-invokes THIS daemon in approval-hook mode (CXX_PERM_HOOK=1).
// SEA single binary → just the binary; source → node + the daemon entry (resolved from
// here, not process.argv[1], which may be a test/smoke entry rather than main.mjs).
async function selfHookCommand() {
  let isSea = false;
  try {
    isSea = (await import("node:sea")).isSea?.() ?? false;
  } catch {
    // node:sea unavailable → treat as source
  }
  if (isSea) return [process.execPath];
  return [process.execPath, fileURLToPath(new URL("./main.mjs", import.meta.url))];
}

const HEAD_BYTES = 64 * 1024;
// Sessions often start with a large file-history-snapshot line (hundreds of KB) that
// pushes the first cwd/prompt-bearing entry past the 64KB head. When the small head
// yields no cwd/preview we re-read up to this cap before falling back to the tail.
const HEAD_MAX_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;
const MODEL_LIST_CACHE_MS = 5 * 60 * 1000;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,127}$/;
const CLAUDE_MODEL_EFFORTS = ["low", "medium", "high", "xhigh"];
const CLAUDE_ALLOWED_EFFORTS = new Set([...CLAUDE_MODEL_EFFORTS, "max"]);
const CLAUDE_FALLBACK_MODELS = [
  { id: "claude-opus-4-8", displayName: "Opus 4.8" },
  { id: "claude-sonnet-5", displayName: "Sonnet 5" },
  { id: "claude-haiku-4-5", displayName: "Haiku 4.5" },
];
const CLAUDE_DEFAULT_MODEL_CANDIDATES = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];

// Base config dir honours CLAUDE_CONFIG_DIR (same override Claude Code itself uses),
// defaulting to ~/.claude. Sessions live under <base>/projects/<slug>/<uuid>.jsonl.
function claudeConfigDir() {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return base;
}

function claudeProjectsDir() {
  return join(claudeConfigDir(), "projects");
}

// Pull the first plain-text user prompt out of a parsed head, plus cwd/gitBranch.
// Skips meta/tool wrapper entries so the preview reads like the human's opening line.
function userText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.find((b) => b?.type === "text");
    return typeof t?.text === "string" ? t.text : "";
  }
  return "";
}

// Command wrappers / system reminders / caveats are not a useful session title.
function looksLikePrompt(text) {
  if (!text) return false;
  const t = text.trimStart();
  if (t.startsWith("<")) return false; // <command-name>…, <system-reminder>…
  if (t.startsWith("Caveat:")) return false;
  return true;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isUsableModelId(id) {
  return typeof id === "string" && MODEL_ID_RE.test(id) && id !== "<synthetic>";
}

function readClaudeSettings() {
  try {
    return JSON.parse(readFileSync(join(claudeConfigDir(), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function claudeLocalConfig() {
  const settings = readClaudeSettings();
  const state = readClaudeState();
  const settingsEnv = settings?.env && typeof settings.env === "object" ? settings.env : {};
  return { settings, state, env: { ...settingsEnv, ...process.env } };
}

function readClaudeState() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  } catch {
    return {};
  }
}

function configuredDefaultModel(settings, env) {
  return firstString(
    settings?.model,
    settings?.defaultModel,
    settings?.modelConfig?.model,
    env.CLAUDE_CODE_MODEL,
    env.CLAUDE_MODEL,
    env.ANTHROPIC_MODEL,
  );
}

function configuredModelOptions(state) {
  return [
    ...modelOptionsFromValue(state?.additionalModelOptionsCache),
    ...modelOptionsFromValue(state?.modelAccessCache),
    ...modelOptionsFromValue(state?.orgModelDefaultCache),
  ];
}

function modelOptionsFromValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(modelOptionsFromValue);
  if (typeof value === "string") return isUsableModelId(value) ? [{ id: value, model: value }] : [];
  if (typeof value !== "object") return [];

  const direct = firstString(value.value, value.model, value.modelId, value.model_id, value.id);
  const out = [];
  if (isUsableModelId(direct)) {
    out.push({
      id: direct,
      model: direct,
      displayName: firstString(value.label, value.displayName, value.display_name, value.name),
      description: firstString(value.description),
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (["value", "model", "modelId", "model_id", "id", "label", "displayName", "display_name", "name", "description"].includes(key)) {
      continue;
    }
    out.push(...modelOptionsFromValue(child));
  }
  return out;
}

function normalizeModel(raw) {
  const id = firstString(raw?.id, raw?.model, raw?.name);
  if (!isUsableModelId(id)) return null;
  const displayName = firstString(raw?.displayName, raw?.display_name, raw?.display, raw?.label);
  const description = firstString(raw?.description);
  return {
    ...raw,
    id,
    model: id,
    displayName: displayName || displayNameForModelId(id) || id,
    description: description || raw?.description || "",
    supportedReasoningEfforts: CLAUDE_MODEL_EFFORTS.map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: raw?.defaultReasoningEffort ?? null,
  };
}

function displayNameForModelId(id) {
  const spaced = String(id || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const claude = spaced.match(/\b(?:claude\s+)?(fable|opus|sonnet|haiku)\s+(\d+)(?:[\s.]+(\d+))?\b/i);
  if (claude) {
    const tier = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    return `${tier} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  const gpt = spaced.match(/\bgpt\s+(\d+)(?:[\s.]+(\d+))?(?:\s+([a-z][a-z0-9]*))?\b/i);
  if (gpt) {
    const suffix = gpt[3] ? ` ${gpt[3][0].toUpperCase()}${gpt[3].slice(1).toLowerCase()}` : "";
    return `GPT ${gpt[1]}${gpt[2] ? `.${gpt[2]}` : ""}${suffix}`;
  }
  const deepseek = spaced.match(/\bdeepseek\s+v?(\d+)(?:\s+([a-z][a-z0-9]*))?\b/i);
  if (deepseek) {
    const suffix = deepseek[2] ? ` ${deepseek[2][0].toUpperCase()}${deepseek[2].slice(1).toLowerCase()}` : "";
    return `DeepSeek V${deepseek[1]}${suffix}`;
  }
  return "";
}

function mergeModels(groups, defaultId) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const raw of group) {
      const model = normalizeModel(raw);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(model);
    }
  }
  const pickedDefault = defaultId && seen.has(defaultId)
    ? defaultId
    : CLAUDE_DEFAULT_MODEL_CANDIDATES.find((id) => seen.has(id)) ?? out[0]?.id;
  const models = out.map((m) => ({ ...m, isDefault: m.id === pickedDefault }));
  const defaultIndex = models.findIndex((m) => m.isDefault);
  if (defaultIndex > 0) models.unshift(models.splice(defaultIndex, 1)[0]);
  return models;
}

export class ClaudeBackend {
  #command;
  #log;
  #closed = false;
  #ready = false;
  // id -> absolute path cache (built during list / readThread; deep-link watch may
  // ask for an id we haven't listed yet, so #findFile also does a direct scan).
  #pathById = new Map();
  // Home "by project" aggregation cache — same contract as AppServer (project-index.mjs).
  #projects = new CachedProjects(() => this.listThreads(5000));
  // Live turns: threadId -> { proc, turnId }, present only while a turn is in flight.
  #turns = new Map();
  #turnSeq = 0;
  // Persistent children: threadId -> proc record (see #spawnProc). A proc may outlive
  // many turns; it is dropped on option change, external session-file writes, idle
  // timeout, fleet cap, or process death.
  #procs = new Map();
  #reapTimer = null;
  // 在册的常驻子进程 pid（落盘到 pidfile）：daemon 被 SIGKILL/崩溃来不及 stop 时，
  // 下次启动靠它清掉孤儿舰队（常驻进程不像旧 per-turn 子进程会自行退出）。
  #livePids = new Set();
  // Brand-new threads have no session file until their first turn — remember the cwd to
  // spawn in (readThread can't derive it yet).
  #pendingCwd = new Map();
  // Default headless permission mode passed to `claude -p`.
  #defaultPermissionMode;
  #modelCache = null;
  #archivePath;
  #archiveState = null; // sessionId -> { archivedAt }

  // —— approval routing (PreToolUse hook → localhost endpoint → phone) ——
  #approvalServer = null;
  #approvalUrl = null; // http://127.0.0.1:<port>/approve
  #approvalToken = null; // per-daemon secret; the hook must present it
  #settingsPath = null; // temp settings.json with the PreToolUse hook, passed via --settings
  #settingsDir = null;
  #selfCmd = null; // [bin, ...] re-invoking this daemon in hook mode (dev: node+main; SEA: binary)
  #pending = new Map(); // requestId -> { resolve, timer }
  #approvalSeq = 0;

  onNotification = () => {}; // (method, params) — live turn events
  onServerRequest = () => {}; // (id, method, params) — approvals (reused by hub, like AppServer)
  onServerRequestCancel = () => {}; // (id) — approval no longer decidable (turn ended); hub drops the card
  onStateChange = () => {}; // (healthy: bool)

  constructor({ command = "claude", log = () => {}, permissionMode = "default", archivePath = null } = {}) {
    this.#command = command;
    this.#log = log;
    this.#defaultPermissionMode = permissionMode;
    this.#archivePath = archivePath ?? join(homedir(), ".cxx", "remote", "claude-archive.json");
  }

  // No server to connect to — reads are always available. `healthy` reflects that the
  // backend is usable at all (projects dir reachable). Writes gate separately (Phase 2).
  get healthy() {
    return this.#ready;
  }

  get url() {
    return "claude:local"; // diagnostics only; there is no socket
  }

  async start() {
    this.#closed = false;
    this.#reapStalePids();
    await this.#startApprovalServer();
    this.#reapTimer = setInterval(() => this.#reapIdleProcs(), 60_000);
    this.#reapTimer.unref?.();
    this.#ready = true;
    this.onStateChange(true);
  }

  // —— 崩溃残留清理（pidfile）——
  #pidFilePath() {
    return join(dirname(this.#archivePath), "claude-pids.json");
  }

  #rememberPid(pid) {
    if (!pid) return;
    this.#livePids.add(pid);
    this.#writePids();
  }

  #forgetPid(pid) {
    if (!pid || !this.#livePids.delete(pid)) return;
    this.#writePids();
  }

  #writePids() {
    writePidFile(this.#pidFilePath(), this.#livePids, this.#log);
  }

  #removePidFile() {
    this.#livePids.clear();
    try {
      rmSync(this.#pidFilePath());
    } catch {
      // ignore
    }
  }

  #reapStalePids() {
    // 身份正则：我们拉起的 headless claude 命令行必含 stream-json 输入标记
    reapStalePids(this.#pidFilePath(), /claude\b.*--input-format stream-json/, {
      log: this.#log,
      label: "claude 进程",
    });
  }

  // Localhost-only approval endpoint + the --settings file that installs the PreToolUse
  // hook pointing at it. Bound to 127.0.0.1 with a per-daemon token so only our hook can
  // submit approvals. Best-effort: if it can't start, turns still run (ungated).
  async #startApprovalServer() {
    this.#approvalToken = randomBytes(24).toString("hex");
    this.#selfCmd = await selfHookCommand();
    this.#approvalServer = createServer((req, res) => this.#handleApproval(req, res));
    await new Promise((resolve) => {
      this.#approvalServer.on("error", (err) => {
        this.#log(`Claude 审批端点启动失败（改为不拦截）: ${err.message}`);
        this.#approvalServer = null;
        resolve();
      });
      this.#approvalServer.listen(0, "127.0.0.1", () => {
        const port = this.#approvalServer.address().port;
        this.#approvalUrl = `http://127.0.0.1:${port}/approve`;
        this.#writeSettings();
        resolve();
      });
    });
  }

  // settings.json with a PreToolUse hook (matcher = gated tools). The hook command
  // re-invokes the daemon in hook mode (CXX_PERM_HOOK=1) with the endpoint + token in the
  // env — shell-inline env works cross dev/SEA (Claude runs hook commands via the shell).
  // Reused across all turns of this daemon.
  #writeSettings() {
    try {
      this.#settingsDir = mkdtempSync(join(tmpdir(), "cxx-claude-"));
      this.#settingsPath = join(this.#settingsDir, "settings.json");
      const bin = this.#selfCmd.map((p) => JSON.stringify(p)).join(" ");
      const command =
        `CXX_PERM_HOOK=1 ` +
        `CXX_APPROVE_URL=${JSON.stringify(this.#approvalUrl)} ` +
        `CXX_APPROVE_TOKEN=${JSON.stringify(this.#approvalToken)} ${bin}`;
      const settings = {
        hooks: {
          PreToolUse: [{ matcher: GATED_TOOLS.join("|"), hooks: [{ type: "command", command }] }],
        },
      };
      writeFileSync(this.#settingsPath, JSON.stringify(settings), { mode: 0o600 });
    } catch (err) {
      this.#log(`写入 Claude 审批 settings 失败（改为不拦截）: ${err.message}`);
      this.#settingsPath = null;
    }
  }

  stop() {
    this.#closed = true;
    this.#ready = false;
    clearInterval(this.#reapTimer);
    this.#reapTimer = null;
    // Daemon exiting: hard-kill the persistent fleet so no orphan claude keeps running
    // (a per-turn child used to exit by itself; a persistent one would linger forever).
    for (const proc of this.#procs.values()) {
      proc.discarded = true;
      clearTimeout(proc.deltaTimer);
      clearTimeout(proc.killTimer);
      proc.deltaBuf = "";
      this.#killProc(proc);
    }
    this.#procs.clear();
    this.#turns.clear();
    // 舰队已经杀掉，pidfile 必须跟着清：main 在 stop() 后同步 process.exit，子进程
    // exit 事件（#forgetPid）来不及触发，不清的话每次干净退出都会留下整份 pid 残留。
    this.#removePidFile();
    // Resolve any waiting approvals as deny so blocked hooks don't hang on shutdown,
    // and tell the hub to drop their cards.
    for (const [requestId, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve({ decision: "deny", reason: "CXX 已关闭" });
      try {
        this.onServerRequestCancel(requestId);
      } catch {
        // hub gone / mid-teardown
      }
    }
    this.#pending.clear();
    try {
      this.#approvalServer?.close();
    } catch {
      // ignore
    }
    if (this.#settingsDir) {
      try {
        rmSync(this.#settingsDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // —— filesystem enumeration ——

  // All session files across every project dir, newest first (by mtime).
  // Cheap: readdir + stat only, no file contents read here.
  #allSessions() {
    const root = claudeProjectsDir();
    if (!existsSync(root)) return [];
    const out = [];
    let projectDirs;
    try {
      projectDirs = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const projentry of projectDirs) {
      if (!projentry.isDirectory()) continue;
      const dir = join(root, projentry.name);
      let files;
      try {
        files = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        const id = f.name.slice(0, -".jsonl".length);
        if (this.#isArchived(id)) continue;
        const path = join(dir, f.name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        out.push({ id, path, mtimeMs });
        this.#pathById.set(id, path);
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  #archiveMap() {
    if (this.#archiveState) return this.#archiveState;
    const map = new Map();
    try {
      const body = JSON.parse(readFileSync(this.#archivePath, "utf8"));
      const sessions = body?.sessions && typeof body.sessions === "object" ? body.sessions : {};
      for (const [id, value] of Object.entries(sessions)) {
        if (typeof id !== "string" || !id) continue;
        const archivedAt = typeof value?.archivedAt === "number" ? value.archivedAt : Date.now();
        map.set(id, { archivedAt });
      }
    } catch {
      // Missing or corrupt archive state behaves as an empty hidden set.
    }
    this.#archiveState = map;
    return map;
  }

  #writeArchiveMap() {
    const sessions = {};
    for (const [id, value] of this.#archiveMap()) sessions[id] = value;
    mkdirSync(dirname(this.#archivePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.#archivePath, `${JSON.stringify({ v: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
  }

  #isArchived(id) {
    return this.#archiveMap().has(id);
  }

  // Locate a session file by id — cache first, then a direct scan (deep-link watch
  // can target a session that was never listed in this process).
  #findFile(id) {
    if (typeof id !== "string" || !id) return null;
    const cached = this.#pathById.get(id);
    if (cached && existsSync(cached)) return cached;
    const root = claudeProjectsDir();
    if (!existsSync(root)) return null;
    let projectDirs;
    try {
      projectDirs = readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const projentry of projectDirs) {
      if (!projentry.isDirectory()) continue;
      const candidate = join(root, projentry.name, `${id}.jsonl`);
      if (existsSync(candidate)) {
        this.#pathById.set(id, candidate);
        return candidate;
      }
    }
    return null;
  }

  // Poll for a just-started session's file to appear. Only ever called with a
  // turn in flight (see readThread); gives up early if that turn ends without
  // producing a file (spawn/auth failure → legitimately missing).
  async #waitForFile(id, timeoutMs = 3000, stepMs = 80) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const path = this.#findFile(id);
      if (path) return path;
      // 只在真的有子进程在产出文件时等；proc 为 null 的占位（startTurn 自己的
      // resolveCwd 阶段）不算——否则每次冷启动都会在这里白等满超时。
      if (!this.#turns.get(id)?.proc || Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  // Read head (and tail, for large files) of a session file and derive display meta:
  // { preview, cwd, gitBranch, name }. Bounded reads keep list latency low even when a
  // session file is multiple MB.
  async #readMeta(path) {
    const meta = { preview: "", cwd: "", gitBranch: "", name: null };
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return meta;
    }
    try {
      const info = await handle.stat();
      if (info.size === 0) return meta;

      const readHead = async (len) => {
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, 0);
        return parseJsonlChunk(`${buf.toString("utf8")}\n`).items;
      };

      let headLen = Math.min(HEAD_BYTES, info.size);
      for (const it of await readHead(headLen)) this.#harvest(it, meta);
      // Small head missed cwd/preview (giant leading snapshot line) — widen once.
      if ((!meta.cwd || !meta.preview) && info.size > headLen) {
        headLen = Math.min(HEAD_MAX_BYTES, info.size);
        for (const it of await readHead(headLen)) this.#harvest(it, meta);
      }

      // Tail window: the ai-title is appended as the session evolves, so the latest one
      // lives near the end; also a guaranteed cwd source (every turn entry carries cwd)
      // when a huge leading snapshot still hid it from the head.
      if (info.size > headLen) {
        const tailLen = Math.min(TAIL_BYTES, info.size);
        const tail = Buffer.alloc(tailLen);
        await handle.read(tail, 0, tailLen, info.size - tailLen);
        for (const it of parseJsonlChunk(tail.toString("utf8")).items) {
          this.#absorbName(it, meta);
          if (!meta.cwd && typeof it?.cwd === "string") meta.cwd = it.cwd;
          if (!meta.gitBranch && typeof it?.gitBranch === "string") meta.gitBranch = it.gitBranch;
        }
      }
    } catch {
      // partial/corrupt file — return whatever we gathered
    } finally {
      await handle.close();
    }
    return meta;
  }

  // Pull display fields out of one head entry: cwd/gitBranch (constant across the
  // session, first wins), the opening human prompt (preview), and the title (name).
  #harvest(it, meta) {
    if (!meta.cwd && typeof it?.cwd === "string") meta.cwd = it.cwd;
    if (!meta.gitBranch && typeof it?.gitBranch === "string") meta.gitBranch = it.gitBranch;
    if (!meta.preview && it?.type === "user" && !it?.isMeta) {
      const text = userText(it.message);
      if (looksLikePrompt(text)) meta.preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    }
    this.#absorbName(it, meta);
  }

  // ai-title wins as the display name; fall back to a non-generic agent-name.
  #absorbName(it, meta) {
    if (it?.type === "ai-title" && typeof it.aiTitle === "string" && it.aiTitle.trim()) {
      meta.name = it.aiTitle.trim().slice(0, 120);
    } else if (
      !meta.name &&
      it?.type === "agent-name" &&
      typeof it.agentName === "string" &&
      it.agentName.trim()
    ) {
      meta.name = it.agentName.trim().slice(0, 120);
    }
  }

  // Session file entry → phone-facing thread view (same shape as AppServer #mapThread,
  // so client-session / web consume it unchanged). `source: "claude"` lets the client
  // tag origin; `path` stays daemon-internal (stripped before the sessions.list frame).
  async #mapSession({ id, path, mtimeMs }) {
    const meta = await this.#readMeta(path);
    return {
      id,
      preview: meta.preview,
      name: meta.name,
      cwd: meta.cwd,
      updatedAt: Math.floor(mtimeMs),
      source: "claude",
      status: "unknown",
      archived: this.#isArchived(id),
      path,
    };
  }

  // —— read API (parity with AppServer) ——

  // Paged newest-first list. Cursor is a numeric offset into the sorted file list
  // (stringified). Only the sliced page reads file contents, so per-call I/O is
  // bounded by `limit` regardless of how many sessions exist on disk.
  async listThreadsPage({ cursor = null, limit = 2000, cwd = null } = {}) {
    // Cap 2000, parity with AppServer: list rows carry no preview and d2c frames are
    // deflated, so 2000 rows stay well under the relay's 256KiB frame cap.
    const target = Math.max(1, Math.min(2000, limit | 0));
    const all = this.#allSessions();
    // cwd filter: Claude has no server-side query, and cwd lives inside each session's
    // meta — so map, then filter. Only reached on project *expand* (not home load), and
    // Claude session counts are modest; #readMeta is cached so repeats are cheap.
    if (cwd) {
      const want = normSep(cwd);
      const mapped = [];
      for (const s of all) {
        const m = await this.#mapSession(s);
        if (normSep(m.cwd) === want) mapped.push(m);
      }
      const off = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
      const page = mapped.slice(off, off + target);
      const next = off + page.length;
      return { items: page, nextCursor: next < mapped.length ? String(next) : null };
    }
    const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
    const slice = all.slice(offset, offset + target);
    const items = [];
    for (const s of slice) items.push(await this.#mapSession(s));
    const nextOffset = offset + slice.length;
    return { items, nextCursor: nextOffset < all.length ? String(nextOffset) : null };
  }

  // Home "by project" aggregation — parity with AppServer.aggregateProjects (project-index.mjs).
  aggregateProjects() {
    return this.#projects.get();
  }

  invalidateProjects() {
    this.#projects.invalidate();
  }

  // Read one session by id (watch / share resolve its file path through this).
  async readThread(threadId) {
    let path = this.#findFile(threadId);
    // A brand-new session's JSONL is created by the `claude -p --session-id`
    // child a beat after spawn, but startSession returns as soon as the turn is
    // dispatched — so the phone's follow-up session.watch can race ahead of the
    // file and 404 ("会话不存在"). When a turn is in flight for this id, wait
    // briefly for the file to land instead of reporting it missing.
    if (!path && this.#turns.get(threadId)?.proc) path = await this.#waitForFile(threadId);
    if (!path) return null;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // fall through with 0
    }
    return this.#mapSession({ id: threadId, path, mtimeMs });
  }

  // Lightweight accumulate-to-limit list (name cache in main.mjs). Newest first.
  async listThreads(limit = 1000) {
    const target = Math.max(1, limit | 0);
    const slice = this.#allSessions().slice(0, target);
    const out = [];
    for (const s of slice) out.push(await this.#mapSession(s));
    return out;
  }

  async archiveThread(threadId) {
    const path = this.#findFile(threadId);
    if (!path) throw new Error("会话不存在");
    this.#archiveMap().set(threadId, { archivedAt: Date.now() });
    this.#writeArchiveMap();
    this.#projects.invalidate();
    this.onNotification("thread/archived", { threadId });
    return { ok: true };
  }

  async unarchiveThread(threadId) {
    if (!this.#archiveMap().delete(threadId)) return { ok: true };
    this.#writeArchiveMap();
    this.#projects.invalidate();
    this.onNotification("thread/unarchived", { threadId });
    return { ok: true };
  }

  // —— write API ——
  // Persistent headless child per thread: `claude -p --input-format stream-json` keeps
  // reading user messages from stdin, so consecutive turns reuse one process (no cold
  // start / MCP re-init per turn). Claude still appends to the SAME session JSONL as it
  // runs, so response BODY keeps flowing to watchers via RolloutTail; stdout carries the
  // turn lifecycle (`result` = turn boundary), typing deltas (`stream_event`, coalesced
  // into agent_message_delta live events) and interrupt control responses.

  resumeThread() {
    // Claude resumes per-turn via `--resume`; nothing to pre-warm.
    return Promise.resolve({});
  }

  // Allocate a new session id. The JSONL file is created by the first turn's
  // `--session-id`, so remember the cwd to spawn that turn in.
  startThread(params = {}) {
    const threadId = randomUUID();
    if (params?.cwd) this.#pendingCwd.set(threadId, params.cwd);
    return Promise.resolve({ threadId });
  }

  // input: string, or the codex-style array [{type:"text",text}|{type:"image",url}].
  // overrides: sanitized per-turn options (model / plan / …).
  async startTurn(threadId, input, overrides = {}) {
    if (this.#turns.has(threadId)) {
      throw new Error("该会话已有进行中的轮次");
    }
    const key = this.#turnOptsKey(overrides);
    const turnId = `ct${++this.#turnSeq}`;
    // 守卫和占位之间不能隔 await：否则同一会话的并发 startTurn 会双双通过守卫、
    // 各自 spawn，先来的常驻子进程被挤出 #procs 后就没人管了（不受闲置回收、
    // stop() 也杀不到），还会两个进程同写一份 session 文件。
    this.#turns.set(threadId, { proc: null, turnId });
    let proc = null;
    try {
      proc = this.#procs.get(threadId) || null;
      // Reuse only when per-turn options match AND nobody else appended to the session
      // file since our last turn (same session driven from the desktop CLI meanwhile →
      // the child's in-memory context would be stale). Mismatch just respawns via
      // --resume, which re-reads the file — correctness never depends on reuse.
      if (proc && (proc.dead || proc.key !== key || !this.#sessionFileUnchanged(proc))) {
        this.#discardProc(proc);
        proc = null;
      }
      if (!proc) {
        const cwd = await this.#resolveCwd(threadId);
        proc = this.#spawnProc(threadId, cwd, key, overrides);
        this.#procs.set(threadId, proc);
        this.#trimProcs(proc);
      }
      proc.turnId = turnId;
      proc.interrupted = false;
      proc.lastUsed = Date.now();
      this.#turns.set(threadId, { proc, turnId });
      try {
        proc.child.stdin.write(`${JSON.stringify(this.#toStreamInput(input))}\n`);
      } catch (err) {
        // stdin already broken（复用窗口内进程刚死）：报错让客户端重试，重试会重新拉起
        throw new Error(`claude 写入失败: ${err.message}`);
      }
    } catch (err) {
      this.#turns.delete(threadId);
      if (proc) {
        proc.turnId = null;
        this.#discardProc(proc);
      }
      throw err;
    }
    return { turnId };
  }

  // Everything that varies per spawn. A different combination can't be applied to a
  // live child, so it forces a respawn (--settings/hook wiring is per-daemon constant).
  #turnOptsKey(overrides = {}) {
    const model = typeof overrides?.model === "string" ? overrides.model : "";
    const effort = CLAUDE_ALLOWED_EFFORTS.has(overrides?.effort) ? overrides.effort : "";
    return JSON.stringify([model, effort, this.#permissionModeFor(overrides) || ""]);
  }

  #spawnProc(threadId, cwd, key, overrides) {
    // Brand-new session (no file yet) → --session-id creates it; existing → --resume
    // continues the SAME file (verified: no fork without --fork-session).
    const isNew = !this.#findFile(threadId);
    const args = [
      "-p",
      isNew ? "--session-id" : "--resume",
      threadId,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (typeof overrides?.model === "string" && overrides.model) args.push("--model", overrides.model);
    if (CLAUDE_ALLOWED_EFFORTS.has(overrides?.effort)) args.push("--effort", overrides.effort);
    const permMode = this.#permissionModeFor(overrides);
    if (permMode) args.push("--permission-mode", permMode);
    // Install the PreToolUse approval hook so gated tools route to the phone. Full access
    // is the explicit bypass mode: omit the hook as well as passing bypassPermissions.
    if (this.#settingsPath && permMode !== "bypassPermissions") args.push("--settings", this.#settingsPath);

    let child;
    try {
      child = spawn(this.#command, args, {
        cwd: cwd || undefined,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // 自成进程组：终止时负 pid 连 MCP/工具子进程一起带走（同 app-server）
      });
    } catch (err) {
      throw new Error(`claude 启动失败: ${err.message}`);
    }
    const proc = {
      threadId,
      child,
      key,
      turnId: null,        // non-null while a turn is in flight on this child
      interrupted: false,  // an interrupt was requested for the current turn
      dead: false,
      discarded: false,    // dropped from the fleet; exit handler must not finalize a turn twice
      lastUsed: Date.now(),
      buf: "",
      skipLine: false,     // 超长行丢弃中：吃到下一个换行为止，保住后续行的分帧
      deltaBuf: "",
      deltaTimer: null,
      ctrlSeq: 0,
      ctrlWaiters: new Map(), // control request_id -> resolve（interrupt 确认回执）
      killTimer: null,
      fileSize: -1, // session 文件在上一轮结束时的大小（外部写入检测基线）
    };
    this.#rememberPid(child.pid);
    // stdin stays open across turns; a dying child EPIPEs it asynchronously and an
    // unhandled stream error would crash the whole daemon.
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // 超长无换行的行（异常洪泛）只丢那一行：清整个 buf 会连带吃掉后面的
      // result 边界行，轮次就永远收不了尾（会话卡死在 running）
      if (proc.skipLine) {
        const nl = chunk.indexOf("\n");
        if (nl < 0) return;
        chunk = chunk.slice(nl + 1);
        proc.skipLine = false;
      }
      proc.buf += chunk;
      const { items, rest } = parseJsonlChunk(proc.buf);
      proc.buf = rest;
      if (proc.buf.length > 8_000_000) {
        proc.buf = "";
        proc.skipLine = true;
      }
      for (const ev of items) this.#onProcEvent(proc, ev);
    });
    child.stderr.on("data", (d) => this.#log(`[claude ${threadId.slice(0, 8)}] ${String(d).trimEnd()}`));
    child.on("error", (err) => {
      this.#log(`claude 进程错误: ${err.message}`);
      this.#onProcExit(proc, -1); // spawn 失败（如 ENOENT）时 exit 事件未必会来
    });
    child.on("exit", (code) => this.#onProcExit(proc, code));
    return proc;
  }

  // stdout stream-json events. `result` is the turn boundary; the child stays alive.
  #onProcEvent(proc, ev) {
    if (ev.type === "stream_event") {
      const e = ev.event;
      if (proc.turnId && e?.type === "content_block_delta" && e.delta?.type === "text_delta"
          && typeof e.delta.text === "string" && e.delta.text) {
        proc.deltaBuf += e.delta.text;
        if (!proc.deltaTimer) {
          proc.deltaTimer = setTimeout(() => {
            proc.deltaTimer = null;
            this.#flushDeltas(proc);
          }, DELTA_FLUSH_MS);
        }
      }
      return;
    }
    if (ev.type === "result") {
      const resultError = ev.is_error === true || (ev.subtype && ev.subtype !== "success");
      // interrupted 只在轮次确实以错误收场时定性为"中止"——中断请求与自然完成赛跑时，
      // 成功的 result 应如实上报 completed（内容已完整落盘，报"已中止"是误导）
      this.#finishTurn(proc, resultError ? (proc.interrupted ? "turn/aborted" : "turn/failed") : "turn/completed");
      return;
    }
    if (ev.type === "control_response") {
      const id = ev.response?.request_id ?? ev.request_id;
      const waiter = proc.ctrlWaiters.get(id);
      if (waiter) {
        proc.ctrlWaiters.delete(id);
        waiter(ev.response?.subtype !== "error");
      }
    }
  }

  // Turn boundary bookkeeping shared by the normal path (result event) and the death
  // path (#onProcExit). Any approval still pending belongs to a turn that can't act on
  // the decision anymore — deny it and clear the phone card.
  #finishTurn(proc, method) {
    if (!proc.turnId) return;
    const { threadId } = proc;
    const turnId = proc.turnId;
    proc.turnId = null;
    proc.interrupted = false;
    proc.lastUsed = Date.now();
    clearTimeout(proc.deltaTimer);
    proc.deltaTimer = null;
    this.#flushDeltas(proc);
    const path = this.#findFile(threadId);
    proc.fileSize = this.#statSize(path);
    if (this.#turns.get(threadId)?.proc === proc) this.#turns.delete(threadId);
    // 只有会话文件已创建才丢 pendingCwd：首轮在落盘前就失败时留着它，重试才不会跑错目录
    if (path) this.#pendingCwd.delete(threadId);
    this.#cancelApprovals(threadId, "CXX: 轮次已结束");
    this.invalidateProjects(); // 新会话/更新时刻变化，令首页立即反映
    this.onNotification(method, { threadId, turnId });
  }

  #onProcExit(proc, code) {
    if (proc.dead) return; // error 与 exit 可能各来一次，只收尾一次
    proc.dead = true;
    this.#forgetPid(proc.child.pid);
    clearTimeout(proc.killTimer);
    for (const waiter of proc.ctrlWaiters.values()) waiter(false);
    proc.ctrlWaiters.clear();
    if (this.#procs.get(proc.threadId) === proc) this.#procs.delete(proc.threadId);
    // Child died mid-turn（正常轮次早在 result 事件就收尾了）：中断算中止，其余算失败。
    // code===0 + 无 result 的怪异组合也按失败报，宁可让手机看到明确的失败横幅。
    if (proc.turnId) {
      const wasInterrupted = proc.interrupted;
      this.#finishTurn(proc, wasInterrupted ? "turn/aborted" : "turn/failed");
      if (!wasInterrupted) this.#log(`claude 轮次进程中途退出(code=${code})`);
    }
  }

  // 合并后的打字流：一次 flush = 每个观看设备一帧（hub 转发为 session.live）
  #flushDeltas(proc) {
    if (!proc.deltaBuf) return;
    const delta = proc.deltaBuf;
    proc.deltaBuf = "";
    this.onNotification("agent_message_delta", { threadId: proc.threadId, delta });
  }

  // 终止统一走 killProcessTree：claude 是常驻的「wrapper → MCP/工具子进程」树，
  // 只 kill wrapper 信号不转发会留孤儿（app-server 踩过的同一坑），组杀+SIGKILL 兜底。
  #killProc(proc) {
    if (proc.dead) return;
    killProcessTree(proc.child.pid, this.#log);
  }

  // Graceful drop: close stdin so claude exits by itself after finishing in-flight
  // work; hard-kill only if it lingers. Marks the record discarded (idempotence).
  #discardProc(proc) {
    if (this.#procs.get(proc.threadId) === proc) this.#procs.delete(proc.threadId);
    if (proc.dead || proc.discarded) return;
    proc.discarded = true;
    try {
      proc.child.stdin.end();
    } catch {
      // already gone
    }
    proc.killTimer = setTimeout(() => this.#killProc(proc), 5_000);
    proc.killTimer.unref?.();
  }

  // Fleet cap: drop the oldest IDLE children beyond PROC_MAX. Busy children are never
  // dropped (turns must not be sacrificed to the cap), so the fleet can transiently
  // exceed the cap under concurrent turns and settles back as they finish.
  #trimProcs(keep) {
    if (this.#procs.size <= PROC_MAX) return;
    const idle = [...this.#procs.values()]
      .filter((p) => p !== keep && !p.turnId)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const p of idle) {
      if (this.#procs.size <= PROC_MAX) break;
      this.#discardProc(p);
    }
  }

  #reapIdleProcs() {
    const now = Date.now();
    for (const proc of this.#procs.values()) {
      if (!proc.turnId && now - proc.lastUsed > PROC_IDLE_MS) this.#discardProc(proc);
    }
  }

  // 复用前哨检查：上轮结束后 session 文件被别人写过（桌面端同会话续聊等）就不复用。
  // 误判成本只是多一次 --resume 冷启动，判漏才伤正确性，所以基线取轮次收尾瞬间。
  #sessionFileUnchanged(proc) {
    if (proc.fileSize < 0) return true; // 尚无基线（进程还没完成过轮次）
    return this.#statSize(this.#findFile(proc.threadId)) === proc.fileSize;
  }

  #statSize(path) {
    try {
      return path ? statSync(path).size : -1;
    } catch {
      return -1;
    }
  }

  #permissionModeFor(overrides = {}) {
    // Plan mode: the phone sends {plan:true}, but the shared hub expands it into codex's
    // `collaborationMode` shape before we're called (session-hub sendMessage). Accept both
    // so `--permission-mode plan` actually takes effect for Claude.
    if (overrides?.plan === true || overrides?.collaborationMode?.mode === "plan") return "plan";
    const sandbox = overrides?.sandboxPolicy?.type;
    const approval = overrides?.approvalPolicy;
    if (approval === "never" || sandbox === "dangerFullAccess") return "bypassPermissions";
    if (sandbox === "workspaceWrite") return "acceptEdits";
    return this.#defaultPermissionMode;
  }

  // Interrupt: stream-json control channel first — claude aborts the turn gracefully
  // (partial output preserved, session file consistent) and emits a `result` that
  // finalizes as turn/aborted. SIGTERM only when unconfirmed (old CLI / wedged child),
  // which matches the legacy behavior exactly.
  async interruptTurn(threadId) {
    const t = this.#turns.get(threadId);
    // t.proc 为 null = startTurn 正在占位（尚未 spawn/写入），没有可打断的东西
    if (!t?.proc) return { ok: true };
    const proc = t.proc;
    const turnId = proc.turnId;
    proc.interrupted = true;
    const confirmed = await this.#requestInterrupt(proc);
    // Guard on the SAME turn — a new turn may have started on this child meanwhile
    // (or the turn already finalized) and must not be killed.
    const killIfSameTurn = () => {
      if (proc.turnId === turnId) this.#killProc(proc);
    };
    if (!confirmed) {
      killIfSameTurn();
      return { ok: true };
    }
    // Confirmed but the closing `result` never lands（异常挂死）: escalate late so the
    // board doesn't stay "running" forever.
    const escalate = setTimeout(killIfSameTurn, 5_000);
    escalate.unref?.();
    return { ok: true };
  }

  #requestInterrupt(proc) {
    if (proc.dead) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        proc.ctrlWaiters.delete(id);
        resolve(ok);
      };
      const id = `cxx-int-${++proc.ctrlSeq}`;
      proc.ctrlWaiters.set(id, finish);
      const timer = setTimeout(() => finish(false), INTERRUPT_GRACE_MS);
      try {
        proc.child.stdin.write(
          `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "interrupt" } })}\n`,
        );
      } catch {
        finish(false);
      }
    });
  }

  // Session cwd for spawn: pending (brand-new) first, else derived from the file's meta.
  async #resolveCwd(threadId) {
    if (this.#pendingCwd.has(threadId)) return this.#pendingCwd.get(threadId);
    const t = await this.readThread(threadId);
    return t?.cwd || undefined;
  }

  // codex-style input → Claude stream-json user message ({type:"user",message:{...}}).
  #toStreamInput(input) {
    const items = typeof input === "string" ? [{ type: "text", text: input }] : input || [];
    const content = [];
    for (const it of items) {
      if (it?.type === "text" && typeof it.text === "string" && it.text) {
        content.push({ type: "text", text: it.text });
      } else if (it?.type === "image" && typeof it.url === "string") {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(it.url);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    return { type: "user", message: { role: "user", content } };
  }

  async #models() {
    const now = Date.now();
    if (this.#modelCache && now - this.#modelCache.at < MODEL_LIST_CACHE_MS) return this.#modelCache.data;
    const { settings, state, env } = claudeLocalConfig();
    const defaultModel = configuredDefaultModel(settings, env);
    const configuredOptions = configuredModelOptions(state);
    const explicitDefault = isUsableModelId(defaultModel) ? [{ id: defaultModel, model: defaultModel }] : [];
    const data = mergeModels([explicitDefault, configuredOptions, CLAUDE_FALLBACK_MODELS], defaultModel);
    this.#modelCache = { at: now, data };
    return data;
  }

  // Generic RPC shim. model/list stays local to the computer being controlled:
  // explicit Claude settings/env model, Claude Code's local config cache, then a tiny fallback.
  async request(method) {
    if (method === "model/list") {
      return { data: await this.#models() };
    }
    return {};
  }

  // —— approval endpoint plumbing ——

  // POST /approve from the PreToolUse hook. Validates the token, raises the request into
  // the hub's approval flow (same onServerRequest the hub already listens to, so the
  // existing phone approval UI + approval.respond path are reused wholesale), and holds
  // the HTTP response open until the phone decides (or a timeout denies).
  #handleApproval(req, res) {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!msg?.token || msg.token !== this.#approvalToken) {
        res.writeHead(403).end();
        return;
      }
      const decision = await this.#requestApproval(msg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(decision));
    });
  }

  #requestApproval({ sessionId, toolName, toolInput, cwd }) {
    const requestId = `ca${++this.#approvalSeq}`;
    const { method, params } = this.#buildApprovalParams(sessionId, toolName, toolInput, cwd);
    return new Promise((resolve) => {
      // 10 min ceiling mirrors the hook side; on timeout deny so a stuck approval frees.
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ decision: "deny", reason: "CXX: 审批超时" });
      }, 10 * 60 * 1000);
      timer.unref?.();
      this.#pending.set(requestId, { resolve, timer, threadId: sessionId });
      // Hand to the hub exactly like AppServer's onServerRequest; method ends with
      // "Approval" so the hub treats it as an approval and pushes a card to the phone.
      this.onServerRequest(requestId, method, params);
    });
  }

  // Tool use → the params shape the phone approval card expects (command vs fileChange).
  #buildApprovalParams(sessionId, toolName, toolInput, cwd) {
    const base = { threadId: sessionId, cwd: cwd ?? toolInput?.cwd ?? null, toolName };
    if (toolName === "Bash") {
      return {
        method: "execCommandApproval",
        params: { ...base, command: toolInput?.command ?? "", reason: toolInput?.description ?? null },
      };
    }
    if (toolName === "Write") {
      return {
        method: "applyPatchApproval",
        params: { ...base, fileChanges: { [toolInput?.file_path ?? "file"]: { add: { content: String(toolInput?.content ?? "") } } } },
      };
    }
    if (toolName === "Edit") {
      const diff = `--- ${toolInput?.file_path ?? ""}\n- ${toolInput?.old_string ?? ""}\n+ ${toolInput?.new_string ?? ""}`;
      return {
        method: "applyPatchApproval",
        params: { ...base, fileChanges: { [toolInput?.file_path ?? "file"]: { update: { unified_diff: diff } } } },
      };
    }
    if (toolName === "MultiEdit") {
      const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : [];
      const diff = edits.map((e) => `- ${e?.old_string ?? ""}\n+ ${e?.new_string ?? ""}`).join("\n");
      return {
        method: "applyPatchApproval",
        params: { ...base, fileChanges: { [toolInput?.file_path ?? "file"]: { update: { unified_diff: diff } } } },
      };
    }
    // NotebookEdit / anything else gated → generic command-style card.
    return {
      method: "execCommandApproval",
      params: { ...base, command: `${toolName} ${JSON.stringify(toolInput ?? {}).slice(0, 300)}` },
    };
  }

  // Deny + drop every approval still pending for a thread whose turn just ended. The
  // orphaned hook (if any) gets a deny; onServerRequestCancel makes the hub remove the card.
  #cancelApprovals(threadId, reason) {
    for (const [requestId, p] of this.#pending) {
      if (p.threadId !== threadId) continue;
      this.#pending.delete(requestId);
      clearTimeout(p.timer);
      p.resolve({ decision: "deny", reason });
      try {
        this.onServerRequestCancel(requestId);
      } catch {
        // hub gone
      }
    }
  }

  // Hub decision → resolve the waiting hook HTTP response. decision ∈
  // accept/acceptForSession/decline/cancel (phone vocab); map to allow/deny.
  respond(requestId, result) {
    const p = this.#pending.get(requestId);
    if (!p) return;
    this.#pending.delete(requestId);
    clearTimeout(p.timer);
    const allow = result?.decision === "accept" || result?.decision === "acceptForSession";
    p.resolve({ decision: allow ? "allow" : "deny", reason: "CXX 远程审批" });
  }

  respondError(requestId) {
    const p = this.#pending.get(requestId);
    if (!p) return;
    this.#pending.delete(requestId);
    clearTimeout(p.timer);
    p.resolve({ decision: "deny", reason: "CXX: 审批处理异常" });
  }
}
