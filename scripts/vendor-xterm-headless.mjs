#!/usr/bin/env node
// Vendor @xterm/headless + @xterm/addon-serialize into daemon/src/vendor/xterm-headless.cjs.
//
// Terminal Mode 的 daemon 侧快照状态机（internal/TERMINAL-MODE.md §10.3）：headless
// xterm 吃 PTY 原始流维护屏幕状态，serialize addon 产出可恢复的 ANSI 快照。
// 二者均为纯 JS（无 .node、无 install 脚本），按 werift 同款模式预打包为单个 CJS，
// 维持 daemon 零 npm 运行依赖 / SEA 可打包。
//
// 版本必须与 web/vendor/xterm 的主版本一致（serialize 产物要喂给 web 端 xterm 恢复）。
// 升级：改 XTERM_VERSION，跑本脚本，review diff，与 web 端一起验证 serialize/restore。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const XTERM_VERSION = "5.5.0";
const SERIALIZE_VERSION = "0.13.0";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(root, "dist", ".xterm-vendor");
const outFile = join(root, "daemon", "src", "vendor", "xterm-headless.cjs");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: "xterm-vendor", private: true }));
run("npm", [
  "install",
  `@xterm/headless@${XTERM_VERSION}`,
  `@xterm/addon-serialize@${SERIALIZE_VERSION}`,
  "--no-audit",
  "--no-fund",
], { cwd: workDir });

writeFileSync(
  join(workDir, "entry.js"),
  [
    'const { Terminal } = require("@xterm/headless");',
    'const { SerializeAddon } = require("@xterm/addon-serialize");',
    "module.exports = { Terminal, SerializeAddon };",
    "",
  ].join("\n"),
);
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

const banner = `// Generated file — do not edit by hand. Regenerate with: node scripts/vendor-xterm-headless.mjs
// @xterm/headless ${XTERM_VERSION} + @xterm/addon-serialize ${SERIALIZE_VERSION}
// (https://github.com/xtermjs/xterm.js), bundled into one CJS file. MIT licensed;
// see the project repository for the full license text.
`;
writeFileSync(outFile, banner + readFileSync(outFile, "utf8"));
console.log(`\n✓ vendored @xterm/headless ${XTERM_VERSION} -> ${outFile}`);
