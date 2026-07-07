#!/usr/bin/env node
// Protocol schema-drift detector.
//
// `app-server` is experimental and its JSON-RPC protocol can change between codex releases.
// This exports the official schema bundle (`codex app-server generate-json-schema`), fingerprints
// it, and compares against a committed baseline. Drift → non-zero exit (the CI alarm). This is
// the cheap, offline half of the compat safety net (the smoke test is the online half).
//
// Usage:
//   node scripts/check-schema.mjs            # compare against baseline, fail on drift
//   node scripts/check-schema.mjs --update   # regenerate the baseline (after reviewing drift)
//   node scripts/check-schema.mjs --codex <path>
//
// The bundle has one nondeterministic file (map key ordering), so every file is canonicalized
// (recursively sorted keys) before hashing — the fingerprint is stable across runs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveCodexCommand } from "../daemon/src/codex-path.mjs";
import { readCodexVersion } from "../daemon/src/codex-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "..", "daemon", "schema", "manifest.json");

const { values } = parseArgs({
  options: { update: { type: "boolean" }, codex: { type: "string" } },
});

// Recursively sort object keys so map-ordering nondeterminism doesn't look like drift.
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])]));
  }
  return x;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

// Build { codexVersion, files: { relpath: sha256(canonical json) } } from a schema bundle dir.
function fingerprint(dir, codexVersion) {
  const files = {};
  for (const abs of walk(dir).sort()) {
    const rel = relative(dir, abs).split("\\").join("/");
    const canon = JSON.stringify(canonical(JSON.parse(readFileSync(abs, "utf8"))));
    files[rel] = createHash("sha256").update(canon).digest("hex");
  }
  // Re-key in sorted order for a stable serialization.
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return { codexVersion, files: sorted };
}

function generate(codexCmd) {
  const dir = mkdtempSync(join(tmpdir(), "cxx-schema-"));
  try {
    execFileSync(codexCmd, ["app-server", "generate-json-schema", "--experimental", "--out", dir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    console.error(`✗ Failed to run 'codex app-server generate-json-schema': ${err.message}`);
    console.error("  Is the official codex installed and is 'app-server' available (codex >= 0.142)?");
    rmSync(dir, { recursive: true, force: true });
    process.exit(2);
  }
  return dir;
}

function diffManifests(baseline, current) {
  const changed = [];
  const removed = [];
  const added = [];
  for (const k of Object.keys(baseline.files)) {
    if (!(k in current.files)) removed.push(k);
    else if (baseline.files[k] !== current.files[k]) changed.push(k);
  }
  for (const k of Object.keys(current.files)) {
    if (!(k in baseline.files)) added.push(k);
  }
  return { changed, removed, added };
}

const codexCmd = resolveCodexCommand(values.codex ?? "codex");
const codexVersion = readCodexVersion(codexCmd);
const dir = generate(codexCmd);
const current = fingerprint(dir, codexVersion);
rmSync(dir, { recursive: true, force: true });

if (values.update) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`✓ Baseline updated: ${relative(process.cwd(), BASELINE)}`);
  console.log(`  codex ${codexVersion ?? "(unknown)"}, ${Object.keys(current.files).length} schema files`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`✗ No baseline at ${relative(process.cwd(), BASELINE)}. Run with --update to create it.`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const { changed, removed, added } = diffManifests(baseline, current);

if (changed.length || removed.length || added.length) {
  console.error("✗ Protocol schema DRIFT detected — the official app-server protocol changed.");
  console.error(`  baseline codex: ${baseline.codexVersion ?? "(unknown)"}  |  current codex: ${codexVersion ?? "(unknown)"}`);
  const show = (label, list) => list.length && console.error(`  ${label} (${list.length}): ${list.slice(0, 20).join(", ")}${list.length > 20 ? " …" : ""}`);
  show("changed", changed);
  show("added", added);
  show("removed", removed);
  console.error("\n  Review the changes against CXX's daemon RPC usage, then run:");
  console.error("    node scripts/check-schema.mjs --update");
  process.exit(1);
}

console.log(`✓ Protocol schema matches baseline (codex ${codexVersion ?? "?"}, ${Object.keys(current.files).length} files).`);
process.exit(0);
