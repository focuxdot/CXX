// 崩溃残留收割(proc-reap.mjs)的防误杀语义:认主跳过 / 命令行验身 / 旧格式兼容。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isProcessAlive, reapStalePids, writePidFile } from "../daemon/src/proc-reap.mjs";

let tmp;
const children = [];

test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cxx-reap-"));
});
test.after(() => {
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
});

// 拉一个带命令行标记的常驻 node 进程,收割器靠标记正则认出它。
// 标记不能带 -- 前缀:node -e 后的 --xxx 会被当非法选项,进程以 code 9 直接退出。
function spawnMarked(marker) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

const waitExit = (child, ms = 5000) =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => reject(new Error("进程未在期限内退出")), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });

test("writePidFile 落盘属主与 pid 列表", () => {
  const file = path.join(tmp, "a.json");
  writePidFile(file, new Set([111, 222]));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { daemon: process.pid, pids: [111, 222] });
});

test("属主 daemon 仍存活:整体跳过,不杀进程也不动 pidfile", async () => {
  const owner = spawnMarked("cxx-reap-fake-owner");
  const victim = spawnMarked("cxx-reap-alive-marker");
  const file = path.join(tmp, "owned.json");
  writeFileSync(file, JSON.stringify({ daemon: owner.pid, pids: [victim.pid] }));
  reapStalePids(file, /cxx-reap-alive-marker/);
  // 给 kill 路径(若误走)一点时间暴露
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(victim.exitCode, null, "并行实例的活进程不能被当残留杀掉");
  assert.ok(existsSync(file), "别人的 pidfile 不能删");
  owner.kill("SIGKILL");
  victim.kill("SIGKILL");
});

test("属主已死:命令行匹配的残留被收割,pidfile 清除", async () => {
  const stale = spawnMarked("cxx-reap-stale-marker");
  const file = path.join(tmp, "stale.json");
  // 属主填一个已死 pid:先拉一个立即退出的进程拿它的 pid
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitExit(dead);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stale.exitCode, null, "标记进程必须还活着,否则收割断言空转");
  writeFileSync(file, JSON.stringify({ daemon: dead.pid, pids: [stale.pid] }));
  reapStalePids(file, /cxx-reap-stale-marker/);
  await waitExit(stale);
  assert.ok(!existsSync(file), "收割后 pidfile 应删除");
});

test("命令行不匹配(pid 被回收给无关进程):不杀", async () => {
  const bystander = spawnMarked("cxx-reap-bystander");
  const file = path.join(tmp, "recycled.json");
  writeFileSync(file, JSON.stringify({ daemon: process.pid, pids: [bystander.pid] }));
  reapStalePids(file, /绝不会匹配的标记/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(bystander.exitCode, null, "命令行对不上就不能杀");
  assert.ok(!existsSync(file));
  bystander.kill("SIGKILL");
});

test("旧格式兼容:纯数字文本与纯数组都能解析并清理文件", () => {
  const intFile = path.join(tmp, "legacy-int.json");
  writeFileSync(intFile, "12345"); // 旧 codex 的 String(pid)
  reapStalePids(intFile, /绝不匹配/);
  assert.ok(!existsSync(intFile));

  const arrFile = path.join(tmp, "legacy-arr.json");
  writeFileSync(arrFile, "[12345]"); // 旧 claude 的纯数组
  reapStalePids(arrFile, /绝不匹配/);
  assert.ok(!existsSync(arrFile));
});

test("isProcessAlive 区分存活与已死", async () => {
  assert.equal(isProcessAlive(process.pid), true);
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitExit(dead);
  assert.equal(isProcessAlive(dead.pid), false);
});
