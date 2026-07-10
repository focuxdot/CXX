// Resolve the official `codex` binary to an absolute path.
//
// A GUI app launched from Finder/Dock inherits a minimal PATH (often just
// /usr/bin:/bin:/usr/sbin:/sbin) — the user's shell PATH (Homebrew, ~/.local/bin,
// nvm, etc.) is NOT present. So a bare spawn("codex") fails for exactly the users we
// target: those who installed the ChatGPT/codex CLI and launch our menu-bar app by clicking it.
// This probes the common install locations directly.
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  delimiter as nativeDelimiter,
  extname as nativeExtname,
  join as nativeJoin,
  win32 as win32Path,
} from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const WINDOWS_SHIM_EXTS = [".exe", ".cmd", ".bat"];

function pathApi(os) {
  return os === "win32"
    ? win32Path
    : { delimiter: nativeDelimiter, extname: nativeExtname, join: nativeJoin };
}

function envValue(env, names) {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  return "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function windowsCommandVariants(path, api) {
  const ext = api.extname(path).toLowerCase();
  if (ext === ".ps1") {
    const stem = path.slice(0, -ext.length);
    return [...WINDOWS_SHIM_EXTS.map((e) => `${stem}${e}`), path];
  }
  if (ext) return [path];
  return WINDOWS_SHIM_EXTS.map((e) => `${path}${e}`);
}

function context(options = {}) {
  return {
    platform: options.platform || platform(),
    homeDir: options.homeDir || homedir(),
    env: options.env || process.env,
    exists: options.exists || existsSync,
  };
}

// Ordered probe list of likely absolute locations, per platform.
function candidatePaths(ctx) {
  const api = pathApi(ctx.platform);
  const home = ctx.homeDir;
  if (ctx.platform === "win32") {
    const pf = envValue(ctx.env, ["ProgramFiles", "PROGRAMFILES"]) || "C:\\Program Files";
    const local = envValue(ctx.env, ["LOCALAPPDATA"]) || api.join(home, "AppData", "Local");
    const appdata = envValue(ctx.env, ["APPDATA"]) || api.join(home, "AppData", "Roaming");
    return unique([
      api.join(local, "Programs", "codex", "codex.exe"),
      api.join(pf, "codex", "codex.exe"),
      api.join(home, ".codex", "bin", "codex.exe"),
      api.join(appdata, "npm", "codex.exe"),
      api.join(appdata, "npm", "codex.cmd"),
      api.join(local, "pnpm", "codex.exe"),
      api.join(local, "pnpm", "codex.cmd"),
    ]);
  }
  return [
    "/opt/homebrew/bin/codex", // macOS Apple Silicon Homebrew
    "/usr/local/bin/codex", // macOS Intel Homebrew / manual
    api.join(home, ".local", "bin", "codex"),
    api.join(home, ".codex", "bin", "codex"),
    "/usr/bin/codex",
  ];
}

function viaWindowsPath(command, ctx) {
  const api = pathApi(ctx.platform);
  const pathValue = envValue(ctx.env, ["PATH", "Path", "path"]);
  if (!pathValue) return null;
  for (const dir of pathValue.split(api.delimiter)) {
    for (const candidate of windowsCommandVariants(api.join(dir, command), api)) {
      if (ctx.exists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveExplicitWindowsCommand(command, ctx) {
  const api = pathApi(ctx.platform);
  for (const candidate of windowsCommandVariants(command, api)) {
    if (ctx.exists(candidate)) return candidate;
  }
  return command;
}

export function codexInvocation(command, args = [], options = {}) {
  const ctx = context(options);
  if (ctx.platform !== "win32") return { command, args };
  const ext = pathApi(ctx.platform).extname(String(command)).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return {
      command: options.comspec || envValue(ctx.env, ["ComSpec", "COMSPEC"]) || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  if (ext === ".ps1") {
    return {
      command: options.powershell || "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    };
  }
  return { command, args };
}

// Ask the login shell for codex's location — recovers nvm / custom PATH setups that
// the probe list misses. Best-effort; never throws.
function viaLoginShell(ctx) {
  if (ctx.platform === "win32") return null;
  const shell = ctx.env.SHELL || "/bin/sh";
  try {
    const out = execFileSync(shell, ["-lic", "command -v codex"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && ctx.exists(out) ? out : null;
  } catch {
    return null;
  }
}

// Resolve `command` (default "codex") to an absolute path, or return the input
// unchanged if nothing better is found (spawn will then surface a clear ENOENT).
export function resolveCodexCommand(command = "codex", options = {}) {
  const ctx = context(options);
  // An explicit absolute/relative path that exists wins — respects user override.
  if (command && (command.includes("/") || command.includes("\\"))) {
    if (ctx.platform === "win32") return resolveExplicitWindowsCommand(command, ctx);
    return ctx.exists(command) ? command : command;
  }
  for (const p of candidatePaths(ctx)) {
    if (ctx.exists(p)) return p;
  }
  if (ctx.platform === "win32") {
    const pathHit = viaWindowsPath(command, ctx);
    if (pathHit) return pathHit;
    return command;
  }
  const shellHit = viaLoginShell(ctx);
  if (shellHit) return shellHit;
  return command; // let spawn fail loudly
}
