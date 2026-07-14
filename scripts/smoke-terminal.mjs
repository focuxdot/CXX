#!/usr/bin/env node
// Terminal Mode Phase 1 冒烟：TerminalManager + 真实 cxx-pty-host + 真实 shell 全链路。
// 覆盖：create → 输出帧 → 指令输入（含回车）→ 快照 attach → 模拟 daemon 重启
// （manager 销毁重建 + restore）→ 接管输入 → EOF 退出帧 → close 回收。
// 用法：node scripts/smoke-terminal.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TerminalManager } from "../daemon/src/terminal-manager.mjs";
import { listPtyHosts } from "../daemon/src/pty-adapter.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostBin = join(repo, "dist", "pty-host", "dev", "cxx-pty-host");
const base = mkdtempSync(join(tmpdir(), "cxx-term-smoke-"));
const ptyDir = join(base, "pty");

let passed = 0;
let failed = 0;
const ok = (n) => (passed++, console.log(`  ✅ ${n}`));
const fail = (n, d) => (failed++, console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSink(deviceId) {
  const frames = [];
  return {
    deviceId,
    frames,
    pushTerminal(method, params, opts) {
      frames.push({ method, params, low: opts?.low === true });
    },
    outputText() {
      return frames
        .filter((f) => f.method === "terminal.output")
        .map((f) => Buffer.from(f.params.data, "base64").toString("utf8"))
        .join("");
    },
    snapshotText() {
      return frames
        .filter((f) => f.method === "terminal.snapshot")
        .map((f) => f.params.data)
        .join("");
    },
    async waitOutput(marker, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (this.outputText().includes(marker)) return;
        await sleep(30);
      }
      throw new Error(`timeout waiting output ${JSON.stringify(marker)}`);
    },
    async waitFrame(method, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = frames.find((x) => x.method === method);
        if (f) return f;
        await sleep(30);
      }
      throw new Error(`timeout waiting frame ${method}`);
    },
  };
}

// 受控环境：不读用户 rc，保证冒烟可重复
const getEnv = () =>
  Promise.resolve({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: base,
    SHELL: "/bin/zsh",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  });

function makeManager(events = []) {
  return new TerminalManager({
    hostBin,
    baseDir: ptyDir,
    log: () => {},
    isCwdAllowed: () => true,
    onEvent: (type, info) => events.push({ type, info }),
    broadcast: () => {},
    getEnv,
  });
}

async function main() {
  console.log("build: go build → dist/pty-host/dev/cxx-pty-host");
  execFileSync("go", ["build", "-o", hostBin, "."], { cwd: join(repo, "pty-host") });

  console.log("phase 1: create + 输出 + 指令输入");
  const events = [];
  let mgr = makeManager(events);
  const view = await mgr.create({
    presetId: "shell",
    cwd: base,
    cols: 80,
    rows: 24,
    deviceId: "devA",
    deviceName: "冒烟A",
  });
  if (view.status === "RUNNING" && view.title.startsWith("Shell · ")) ok("create：RUNNING + 自动标题");
  else fail("create", JSON.stringify(view));

  const sinkA = makeSink("devA");
  const att = mgr.attach(sinkA, { terminalId: view.terminalId, deviceId: "devA", cols: 80, rows: 24 });
  if (att.mode === "snapshot") ok("首次 attach：快照模式");
  else fail("首次 attach", att.mode);

  // 指令模式输入（text + submit）：标记用 $((...)) 计算值防回显竞态
  mgr.input(view.terminalId, "devA", { text: "echo SMOKE-$((6*7))-OK", submit: true });
  await sinkA.waitOutput("SMOKE-42-OK");
  ok("指令输入 → terminal.output 帧往返");

  // 中文
  mgr.input(view.terminalId, "devA", { text: "echo 终端冒烟$((1+1))号", submit: true });
  await sinkA.waitOutput("终端冒烟2号");
  ok("CJK 输出经 base64 帧无损");

  // 新观察者快照含历史
  const sinkB = makeSink("devB");
  mgr.attach(sinkB, { terminalId: view.terminalId, deviceId: "devB" });
  if (sinkB.snapshotText().includes("SMOKE-42-OK")) ok("第二设备 attach：快照含历史画面");
  else fail("第二设备快照", "缺内容");

  // resize（owner）
  mgr.resize(view.terminalId, "devA", 100, 30);
  mgr.input(view.terminalId, "devA", { text: "echo SIZE=$(stty size)", submit: true });
  await sinkA.waitOutput("SIZE=30 100");
  ok("resize 生效（stty size = 30 100）");

  console.log("phase 2: 模拟 daemon 重启（manager 销毁 → restore）");
  mgr.input(view.terminalId, "devA", { text: "echo BEFORE-$((5*5))-RESTART", submit: true });
  await sinkA.waitOutput("BEFORE-25-RESTART");
  mgr.stop(); // daemon 死了：host 与 shell 存活
  await sleep(300);

  const events2 = [];
  mgr = makeManager(events2);
  await mgr.restore();
  const list = mgr.list();
  if (list.length === 1 && list[0].status === "DETACHED" && list[0].terminalId === view.terminalId) {
    ok("restore：注册目录扫描恢复 DETACHED 会话");
  } else {
    fail("restore", JSON.stringify(list));
  }
  await sleep(800); // ring 重放 + resize 抖动收敛
  const sinkC = makeSink("devC");
  mgr.attach(sinkC, { terminalId: view.terminalId, deviceId: "devC" });
  if (sinkC.snapshotText().includes("BEFORE-25-RESTART")) ok("restore 后快照：重启前画面已恢复");
  else fail("restore 快照", "缺重启前内容");

  // 重启后 owner 清零 → 显式接管后可输入（同一子进程）
  mgr.takeover(view.terminalId, "devC", "冒烟C");
  mgr.input(view.terminalId, "devC", { text: "echo AFTER-$((4*8))-RESTART", submit: true });
  await sinkC.waitOutput("AFTER-32-RESTART");
  ok("接管 + 输入：同一子进程继续响应");

  console.log("phase 3: 退出与回收");
  mgr.signal(view.terminalId, "devC", "eof");
  const exited = await sinkC.waitFrame("terminal.exited");
  if (exited.params.exitCode === 0) ok("EOF：terminal.exited 帧（exit 0）");
  else fail("EOF 退出", JSON.stringify(exited.params));
  // 外部退出（非 close 自发起）应产生通知事件
  if (events2.some((e) => e.type === "exited")) ok("退出通知事件已上抛（非自发起）");
  else fail("退出通知事件", JSON.stringify(events2));

  const closed = mgr.close(view.terminalId, "devC");
  if (closed.removed === true && mgr.list().length === 0) ok("close 已退出终端：移除并回收目录");
  else fail("close 回收", JSON.stringify(closed));
  await sleep(500);
  const leftovers = listPtyHosts(ptyDir).filter((s) => s.alive);
  if (leftovers.length === 0) ok("无残留 host 进程");
  else fail("残留治理", JSON.stringify(leftovers));

  mgr.stop();
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`\nFAIL: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(200);
    for (const s of listPtyHosts(ptyDir)) {
      try {
        process.kill(s.hostPid, "SIGKILL");
      } catch {}
      try {
        process.kill(s.childPid, "SIGKILL");
      } catch {}
    }
    rmSync(base, { recursive: true, force: true });
  });
