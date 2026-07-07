// Minimum-supported-version gate for the official `claude` (Claude Code) CLI.
//
// The Claude backend drives writes through headless streaming mode:
//   claude -p --resume <id> --session-id <uuid> \
//     --input-format stream-json --output-format stream-json --verbose
// `--session-id`, `--fork-session` and stream-json bidirectional I/O all landed in
// the 2.x line, so we pin a documented minimum and check it at startup — a too-old
// claude fails with a clear message instead of confusing mid-turn errors.
//
// Policy mirrors codex-version.mjs: hard-fail only when we can parse the version AND
// it is clearly below the minimum; unknown/unparseable warns and continues.
import { execFileSync } from "node:child_process";

// Documented minimum. The read path (list/watch of ~/.claude/projects JSONL) works on
// any version; this floor is about the write path. Bump alongside the compat matrix.
export const MIN_CLAUDE_VERSION = "2.0.0";

// Parse a semver-ish triple out of arbitrary version output, e.g. "2.1.201 (Claude Code)".
export function parseClaudeVersion(text) {
  const m = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// -1 if a < b, 0 if equal, 1 if a > b. Inputs are parsed triples.
export function compareVersion(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

// Run `<command> --version` and return its raw stdout (trimmed), or null on any failure.
export function readClaudeVersion(command) {
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Assess the installed claude against MIN_CLAUDE_VERSION.
// Returns { raw, parsed, ok, belowMin } (same shape as checkCodexVersion).
export function checkClaudeVersion(command) {
  const raw = readClaudeVersion(command);
  const parsed = raw ? parseClaudeVersion(raw) : null;
  const min = parseClaudeVersion(MIN_CLAUDE_VERSION);
  const belowMin = parsed ? compareVersion(parsed, min) < 0 : false;
  return { raw, parsed, ok: !belowMin, belowMin };
}
