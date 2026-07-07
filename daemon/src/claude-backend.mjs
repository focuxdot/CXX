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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CachedProjects, normSep } from "./project-index.mjs";
import { parseJsonlChunk } from "./rollout-tail.mjs";

// Tools gated behind approval (mutating / command execution). Read-only tools
// (Read/Grep/Glob/…) run freely so the phone isn't spammed with trivial approvals.
const GATED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];

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
const MODEL_LIST_TIMEOUT_MS = 8000;
const MODEL_SCAN_LIMIT = 200;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
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
  const settingsEnv = settings?.env && typeof settings.env === "object" ? settings.env : {};
  return { settings, env: { ...settingsEnv, ...process.env } };
}

function modelListUrl(baseUrl) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
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

function modelIdsFromItem(item) {
  return [
    item?.message?.model,
    item?.model,
    item?.model_id,
    item?.modelId,
    item?.request?.model,
    item?.response?.model,
  ].filter(isUsableModelId);
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
  return out.map((m) => ({ ...m, isDefault: m.id === pickedDefault }));
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
  // Live turns: threadId -> { child, turnId }. One `claude -p` child per in-flight turn.
  #turns = new Map();
  #turnSeq = 0;
  // Brand-new threads have no session file until their first turn — remember the cwd to
  // spawn in (readThread can't derive it yet).
  #pendingCwd = new Map();
  // Default headless permission mode passed to `claude -p`.
  #defaultPermissionMode;
  #modelCache = null;

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

  constructor({ command = "claude", log = () => {}, permissionMode = "default" } = {}) {
    this.#command = command;
    this.#log = log;
    this.#defaultPermissionMode = permissionMode;
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
    await this.#startApprovalServer();
    this.#ready = true;
    this.onStateChange(true);
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
    for (const t of this.#turns.values()) {
      try {
        t.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    this.#turns.clear();
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
    const path = this.#findFile(threadId);
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

  // —— write API ——
  // No persistent server: each turn is one `claude -p ... --input-format stream-json`
  // child. Claude appends to the SAME session JSONL as it runs, so response content
  // reaches watchers through the existing RolloutTail — here we only spawn the child and
  // translate its lifecycle into turn/started·completed·failed for the board/running state.

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
    const cwd = await this.#resolveCwd(threadId);
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
      });
    } catch (err) {
      throw new Error(`claude 启动失败: ${err.message}`);
    }
    const turnId = `ct${++this.#turnSeq}`;
    this.#turns.set(threadId, { child, turnId });

    // Feed the single user message, then close stdin so `-p` processes and exits.
    try {
      child.stdin.write(`${JSON.stringify(this.#toStreamInput(input))}\n`);
      child.stdin.end();
    } catch {
      // stdin may already be gone if spawn failed late; exit handler will finalize
    }

    // Watch stdout only for the terminal result marker; body flows via file tail.
    let buf = "";
    let sawResult = false;
    let resultError = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "result") {
          sawResult = true;
          resultError = ev.is_error === true || (ev.subtype && ev.subtype !== "success");
        }
      }
    });
    child.stderr.on("data", (d) => this.#log(`[claude ${threadId.slice(0, 8)}] ${String(d).trimEnd()}`));
    child.on("error", (err) => {
      this.#turns.delete(threadId);
      this.#cancelApprovals(threadId, "CXX: 轮次已结束");
      this.#log(`claude 轮次进程错误: ${err.message}`);
      this.onNotification("turn/failed", { threadId, turnId });
    });
    child.on("exit", (code) => {
      this.#turns.delete(threadId);
      this.#pendingCwd.delete(threadId);
      // Turn ended (completed, failed, or interrupted). Any approval still pending for it
      // belongs to a now-dead claude that can't act on the decision — deny it and clear the
      // phone card, else it lingers up to the 10-min timeout as a no-op.
      this.#cancelApprovals(threadId, "CXX: 轮次已结束");
      this.invalidateProjects(); // 新会话/更新时刻变化，令首页立即反映
      const failed = code !== 0 || resultError || !sawResult;
      this.onNotification(failed ? "turn/failed" : "turn/completed", { threadId, turnId });
    });
    return { turnId };
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

  interruptTurn(threadId) {
    const t = this.#turns.get(threadId);
    if (t?.child) {
      try {
        t.child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    return Promise.resolve({ ok: true });
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

  async #configuredModels() {
    const { env } = claudeLocalConfig();
    const baseUrl = firstString(env.ANTHROPIC_BASE_URL);
    if (!baseUrl) return [];
    const headers = { accept: "application/json", "anthropic-version": "2023-06-01" };
    if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
    if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
      const res = await fetch(modelListUrl(baseUrl), { headers, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      return items.map((m) => ({
        id: m.id ?? m.model ?? m.name,
        model: m.id ?? m.model ?? m.name,
        displayName: m.displayName ?? m.display_name ?? m.name,
        description: m.description,
      }));
    } catch (err) {
      this.#log(`读取 Claude 本机模型接口失败，改用本地历史/兜底: ${err.message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async #historyModels() {
    const seen = new Set();
    const out = [];
    for (const session of this.#allSessions().slice(0, MODEL_SCAN_LIMIT)) {
      let handle;
      try {
        handle = await open(session.path, "r");
        const info = await handle.stat();
        if (info.size <= 0) continue;
        const len = Math.min(TAIL_BYTES, info.size);
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, info.size - len);
        for (const item of parseJsonlChunk(buf.toString("utf8")).items) {
          for (const id of modelIdsFromItem(item)) {
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, model: id });
          }
        }
      } catch {
        // Ignore corrupt or concurrently-written session files.
      } finally {
        await handle?.close();
      }
    }
    return out;
  }

  async #models() {
    const now = Date.now();
    if (this.#modelCache && now - this.#modelCache.at < MODEL_LIST_CACHE_MS) return this.#modelCache.data;
    const { settings, env } = claudeLocalConfig();
    const defaultModel = configuredDefaultModel(settings, env);
    const [configured, history] = await Promise.all([this.#configuredModels(), this.#historyModels()]);
    const explicitDefault = isUsableModelId(defaultModel) ? [{ id: defaultModel, model: defaultModel }] : [];
    const data = mergeModels([configured, history, explicitDefault, CLAUDE_FALLBACK_MODELS], defaultModel);
    this.#modelCache = { at: now, data };
    return data;
  }

  // Generic RPC shim. model/list prefers the local Claude Code configuration
  // (ANTHROPIC_BASE_URL / token), then local session history, then a tiny fallback.
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
