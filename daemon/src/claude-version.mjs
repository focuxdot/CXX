// Minimum-supported-version gate for the official `claude` (Claude Code) CLI.
//
// The Claude backend drives writes through headless streaming mode:
//   claude -p --resume <id> --session-id <uuid> \
//     --input-format stream-json --output-format stream-json --verbose
// `--session-id`, `--fork-session` and stream-json bidirectional I/O all landed in
// the 2.x line, so we pin a documented minimum and check it at startup — a too-old
// claude fails with a clear message instead of confusing mid-turn errors.
//
// Parse/compare/policy live in version.mjs (checkMinVersion, shared with codex-version):
// hard-fail only when the version parses AND is clearly below the minimum.
import { execFileSync } from "node:child_process";

import { checkMinVersion } from "./version.mjs";

// Documented minimum. The read path (list/watch of ~/.claude/projects JSONL) works on
// any version; this floor is about the write path. Bump alongside the compat matrix.
export const MIN_CLAUDE_VERSION = "2.0.0";

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
  return checkMinVersion(readClaudeVersion(command), MIN_CLAUDE_VERSION);
}
