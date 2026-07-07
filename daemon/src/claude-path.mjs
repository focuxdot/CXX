// Resolve the official `claude` (Claude Code) binary to an absolute path.
//
// Same problem as codex-path.mjs: a GUI app launched from Finder/Dock inherits a
// minimal PATH, so a bare spawn("claude") fails for exactly our target users. Probe
// the common Claude Code install locations directly, then fall back to the login shell.
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Ordered probe list of likely absolute locations, per platform.
function candidatePaths() {
  const home = homedir();
  if (platform() === "win32") {
    const local = process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
    const pf = process.env["ProgramFiles"] || "C:/Program Files";
    return [
      join(home, ".claude", "local", "claude.exe"),
      join(local, "Programs", "claude", "claude.exe"),
      join(pf, "claude", "claude.exe"),
    ];
  }
  return [
    // Native installer (curl -fsSL claude.ai/install.sh) drops here:
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    // Homebrew / npm-global symlinks:
    "/opt/homebrew/bin/claude", // macOS Apple Silicon Homebrew
    "/usr/local/bin/claude", // macOS Intel Homebrew / npm -g
    "/usr/bin/claude",
  ];
}

// Ask the login shell for claude's location — recovers nvm / custom PATH setups the
// probe list misses. Best-effort; never throws.
function viaLoginShell() {
  if (platform() === "win32") return null;
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const out = execFileSync(shell, ["-lic", "command -v claude"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

// Resolve `command` (default "claude") to an absolute path, or return the input
// unchanged if nothing better is found (spawn will then surface a clear ENOENT).
export function resolveClaudeCommand(command = "claude") {
  // An explicit absolute path wins — respects user override (even if missing, so
  // spawn surfaces a clear error at the given path).
  if (command && (command.includes("/") || command.includes("\\"))) {
    return command;
  }
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  const shellHit = viaLoginShell();
  if (shellHit) return shellHit;
  return command; // let spawn fail loudly
}

// Whether a usable `claude` binary appears to be installed (drives whether the
// Claude backend is registered at all — absent binary ⇒ agent simply not offered).
export function claudeAvailable(command = "claude") {
  const resolved = resolveClaudeCommand(command);
  return resolved.includes("/") || resolved.includes("\\") ? existsSync(resolved) : false;
}
