#!/usr/bin/env node
// Build the daemon into a single self-contained executable via Node SEA.
//
// Pipeline:
//   1. esbuild bundles the ESM daemon (entry.mjs) into one CJS file
//   2. `node --experimental-sea-config` produces the SEA blob
//   3. a copy of the current `node` binary is made
//   4. (macOS) its signature is stripped, blob injected with postject, then re-signed
//
// The daemon has zero runtime npm deps — it uses node: builtins plus pre-bundled
// pure-JS vendor files (daemon/src/vendor/, see scripts/vendor-werift.mjs), so the
// bundle is self-contained. Output: dist/sea/cxx-daemon (+ .exe on Windows).
//
// IMPORTANT: the base runtime must be an OFFICIAL Node.js binary. Homebrew's node is
// built without the SEA fuse sentinel, so postject can't inject into it. This script
// downloads and caches the official Node matching the running version/arch and injects
// into that — making the build reproducible regardless of how you installed node.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "sea");
const cacheDir = join(root, "dist", ".node-cache");
const isWin = process.platform === "win32";
const binName = isWin ? "cxx-daemon.exe" : "cxx-daemon";
const npx = isWin ? "npx.cmd" : "npx";
const binPath = join(outDir, binName);
const bundlePath = join(outDir, "bundle.cjs");
const blobPath = join(outDir, "cxx-daemon.blob");
const configPath = join(outDir, "sea-config.json");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd)) {
    const quote = (a) => `"${String(a).replaceAll('"', '""')}"`;
    const commandLine = [cmd, ...args.map(quote)].join(" ");
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", commandLine], {
      stdio: "inherit",
      ...opts,
    });
  }
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function runNpx(args) {
  if (isWin) {
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if (existsSync(cli)) return run(process.execPath, [cli, ...args]);
  }
  return run(npx, args);
}

// Return the path to an official Node binary matching this version/arch, downloading
// and caching it under dist/.node-cache if needed. Verifies the SEA fuse is present.
function officialNodeBinary() {
  const ver = process.version; // e.g. v22.22.2
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win" : "linux";
  if (platform === "win") {
    // Windows: official zip ships node.exe; keep the currently running node if it has the fuse.
    if (hasFuse(process.execPath)) return process.execPath;
    throw new Error("Windows SEA base node lacks the fuse; download official node.exe manually.");
  }
  const dirName = `node-${ver}-${platform}-${arch}`;
  const cached = join(cacheDir, dirName, "bin", "node");
  if (existsSync(cached) && hasFuse(cached)) return cached;
  mkdirSync(cacheDir, { recursive: true });
  const tarball = `${dirName}.tar.gz`;
  const url = `https://nodejs.org/dist/${ver}/${tarball}`;
  const tarPath = join(cacheDir, tarball);
  console.log(`→ downloading official Node runtime: ${url}`);
  run("curl", ["-fsSL", url, "-o", tarPath]);
  run("tar", ["-xzf", tarPath, "-C", cacheDir]);
  if (!existsSync(cached)) throw new Error(`extracted node not found at ${cached}`);
  if (!hasFuse(cached)) throw new Error(`official node at ${cached} unexpectedly lacks the SEA fuse`);
  return cached;
}

function hasFuse(bin) {
  try {
    return readFileSync(bin).includes(Buffer.from(FUSE));
  } catch {
    return false;
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. bundle ESM -> single CJS. --format=cjs is required: SEA runs the main as CommonJS.
// The SEA binary carries no package.json, so the version is burned in here via define
// (consumed by daemon/src/version.mjs for the tray "check update" comparison).
const pkgVersion =
  process.env.CXX_VERSION ||
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
console.log("→ bundling daemon with esbuild ...");
runNpx([
  "--yes",
  "esbuild",
  join(root, "daemon", "sea", "entry.mjs"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  `--define:__CXX_VERSION__=${JSON.stringify(pkgVersion)}`,
  `--outfile=${bundlePath}`,
]);

// 2. SEA blob
console.log("→ generating SEA blob ...");
writeFileSync(
  configPath,
  JSON.stringify(
    { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", configPath]);

// 3. copy an official node binary (must contain the SEA fuse — see officialNodeBinary)
console.log("→ obtaining official node runtime ...");
const baseNode = officialNodeBinary();
copyFileSync(baseNode, binPath);
if (!isWin) execFileSync("chmod", ["+w", binPath]);

// 4. strip signature (macOS), inject blob, re-sign
if (process.platform === "darwin") {
  console.log("→ removing existing signature (macOS) ...");
  try {
    run("codesign", ["--remove-signature", binPath]);
  } catch {
    // unsigned copy is fine; postject will still inject
  }
}

console.log("→ injecting SEA blob with postject ...");
const postjectArgs = [
  "--yes",
  "postject",
  binPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  FUSE,
];
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
runNpx(postjectArgs);

if (process.platform === "darwin") {
  // Ad-hoc sign for local runs. Release builds re-sign with a Developer ID in the
  // packaging script (scripts/build-app.mjs) gated on CODESIGN_IDENTITY.
  const identity = process.env.CODESIGN_IDENTITY || "-";
  console.log(`→ codesign (identity: ${identity}) ...`);
  run("codesign", ["--sign", identity, "--force", "--timestamp=none", binPath]);
}

console.log(`\n✓ built ${binPath}`);
if (!existsSync(binPath)) {
  console.error("✗ output binary missing");
  process.exit(1);
}
