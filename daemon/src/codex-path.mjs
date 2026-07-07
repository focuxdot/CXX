// Resolve the official `codex` binary to an absolute path.
//
// A GUI app launched from Finder/Dock inherits a minimal PATH (often just
// /usr/bin:/bin:/usr/sbin:/sbin) — the user's shell PATH (Homebrew, ~/.local/bin,
// nvm, etc.) is NOT present. So a bare spawn("codex") fails for exactly the users we
// target: those who installed Codex and launch our menu-bar app by clicking it.
// This probes the common install locations directly.
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Ordered probe list of likely absolute locations, per platform.
function candidatePaths() {
  const home = homedir();
  if (platform() === "win32") {
    const pf = process.env["ProgramFiles"] || "C:/Program Files";
    const local = process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
    return [
      join(local, "Programs", "codex", "codex.exe"),
      join(pf, "codex", "codex.exe"),
      join(home, ".codex", "bin", "codex.exe"),
    ];
  }
  return [
    "/opt/homebrew/bin/codex", // macOS Apple Silicon Homebrew
    "/usr/local/bin/codex", // macOS Intel Homebrew / manual
    join(home, ".local", "bin", "codex"),
    join(home, ".codex", "bin", "codex"),
    "/usr/bin/codex",
  ];
}

// Ask the login shell for codex's location — recovers nvm / custom PATH setups that
// the probe list misses. Best-effort; never throws.
function viaLoginShell() {
  if (platform() === "win32") return null;
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const out = execFileSync(shell, ["-lic", "command -v codex"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

// Resolve `command` (default "codex") to an absolute path, or return the input
// unchanged if nothing better is found (spawn will then surface a clear ENOENT).
export function resolveCodexCommand(command = "codex") {
  // An explicit absolute path that exists wins — respects user override.
  if (command && (command.includes("/") || command.includes("\\"))) {
    return existsSync(command) ? command : command;
  }
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  const shellHit = viaLoginShell();
  if (shellHit) return shellHit;
  return command; // let spawn fail loudly
}
