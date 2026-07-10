#!/usr/bin/env node
// Vendor werift (pure-JS WebRTC stack) into daemon/src/vendor/werift.cjs.
//
// The daemon has a zero-npm-deps policy so it can run from a clean checkout and
// bundle into a Node SEA binary (see build-sea.mjs). werift is pure JS with pure-JS
// deps (verified: no .node files, no install scripts), so we pre-bundle it into a
// single CJS file with esbuild — same pattern as vendor/qrcode.cjs, just generated.
//
// Rerun this script to upgrade: bump WERIFT_VERSION, run, review the diff, commit.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WERIFT_VERSION = "0.23.0";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(root, "dist", ".werift-vendor");
const outFile = join(root, "daemon", "src", "vendor", "werift.cjs");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: "werift-vendor", private: true }));
run("npm", ["install", `werift@${WERIFT_VERSION}`, "--no-audit", "--no-fund"], { cwd: workDir });

// 入口只转出 module.exports：消费方用默认导入解构（Node ESM 对大型 CJS 的具名导出
// 静态分析不可靠，默认导入恒可用）
writeFileSync(join(workDir, "entry.js"), 'module.exports = require("werift");\n');
run("npx", [
  "--yes",
  "esbuild",
  join(workDir, "entry.js"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  `--outfile=${outFile}`,
]);

const banner = `// Generated file — do not edit by hand. Regenerate with: node scripts/vendor-werift.mjs
// werift ${WERIFT_VERSION} (https://github.com/shinyoshiaki/werift-webrtc) and its
// dependencies, bundled into one CJS file. werift is MIT licensed; see the project
// repository for the full license text and third-party notices.
`;
writeFileSync(outFile, banner + readFileSync(outFile, "utf8"));
console.log(`\n✓ vendored werift ${WERIFT_VERSION} -> ${outFile}`);
