// Minimum-supported-version gate for the official `codex` CLI.
//
// `app-server` is still experimental upstream, so the JSON-RPC surface CXX depends on
// (initialize, thread/*, turn/*, approval flow, experimental collaborationMode/goal) can
// shift between releases. We pin a documented minimum and check it at daemon startup so a
// too-old codex fails with a clear message instead of mysterious mid-session RPC errors.
//
// Parse/compare/policy live in version.mjs (checkMinVersion, shared with claude-version):
// hard-fail only when the version parses AND is clearly below the minimum — a version
// string format change must never brick startup for users on a perfectly new codex.
import { execFileSync } from "node:child_process";

import { codexInvocation } from "./codex-path.mjs";
import { checkMinVersion } from "./version.mjs";

// Documented minimum. Bump alongside the compat matrix (see docs) once a newer floor is
// verified. 0.142.x is the first release where the full app-server chain was validated.
export const MIN_CODEX_VERSION = "0.142.0";

// Run `<command> --version` and return its raw stdout (trimmed), or null on any failure.
export function readCodexVersion(command) {
  try {
    const invocation = codexInvocation(command, ["--version"]);
    return execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Assess the installed codex against MIN_CODEX_VERSION.
// Returns { raw, parsed, ok, belowMin }:
//   - raw:      the version string reported (or null if `--version` couldn't be run)
//   - parsed:   the parsed triple (or null if unparseable)
//   - belowMin: true only when parsed AND strictly below the minimum
//   - ok:       true when not known-below-min (i.e. proceed) — unknown/unparseable counts as ok
export function checkCodexVersion(command) {
  return checkMinVersion(readCodexVersion(command), MIN_CODEX_VERSION);
}
