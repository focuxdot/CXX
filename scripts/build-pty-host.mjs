#!/usr/bin/env node
// 交叉编译 cxx-pty-host 三平台产物 → dist/pty-host/<goos>-<goarch>/
// 用法：node scripts/build-pty-host.mjs [--only darwin-arm64,...]
// CGO_ENABLED=0：creack/pty 与 conpty 均为纯 syscall 实现，静态产物无 libc 依赖。
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repo, "pty-host");
const outBase = join(repo, "dist", "pty-host");

const MATRIX = [
  { goos: "darwin", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "windows", goarch: "amd64" },
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
];

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",")
  : null;

for (const { goos, goarch } of MATRIX) {
  const key = `${goos}-${goarch}`;
  if (only && !only.includes(key)) continue;
  const dir = join(outBase, key);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, goos === "windows" ? "cxx-pty-host.exe" : "cxx-pty-host");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", bin, "."], {
    cwd: srcDir,
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    stdio: "inherit",
  });
  const mb = (statSync(bin).size / 1024 / 1024).toFixed(2);
  console.log(`${key.padEnd(14)} ${mb} MB  ${bin}`);
}
