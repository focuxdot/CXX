// Minimum-supported-version gate for the official `codex` CLI.
//
// `app-server` is still experimental upstream, so the JSON-RPC surface CXX depends on
// (initialize, thread/*, turn/*, approval flow, experimental collaborationMode/goal) can
// shift between releases. We pin a documented minimum and check it at daemon startup so a
// too-old codex fails with a clear message instead of mysterious mid-session RPC errors.
//
// Policy: hard-fail only when we can parse the version AND it is clearly below the minimum.
// If `codex --version` can't be run or its format changes, we warn and continue — a version
// string format change must never brick startup for users on a perfectly new codex.
import { execFileSync } from "node:child_process";

// Documented minimum. Bump alongside the compat matrix (see docs) once a newer floor is
// verified. 0.142.x is the first release where the full app-server chain was validated.
export const MIN_CODEX_VERSION = "0.142.0";

// Parse a semver-ish triple out of arbitrary version output, e.g. "codex-cli 0.142.5".
// Returns { major, minor, patch } or null when nothing version-like is found.
export function parseCodexVersion(text) {
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
export function readCodexVersion(command) {
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

// Assess the installed codex against MIN_CODEX_VERSION.
// Returns { raw, parsed, ok, belowMin }:
//   - raw:      the version string reported (or null if `--version` couldn't be run)
//   - parsed:   the parsed triple (or null if unparseable)
//   - belowMin: true only when parsed AND strictly below the minimum
//   - ok:       true when not known-below-min (i.e. proceed) — unknown/unparseable counts as ok
export function checkCodexVersion(command) {
  const raw = readCodexVersion(command);
  const parsed = raw ? parseCodexVersion(raw) : null;
  const min = parseCodexVersion(MIN_CODEX_VERSION);
  const belowMin = parsed ? compareVersion(parsed, min) < 0 : false;
  return { raw, parsed, ok: !belowMin, belowMin };
}
