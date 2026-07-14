#!/usr/bin/env node
// pty-host Phase 0 冒烟（本机可验部分，见 internal/TERMINAL-MODE.md §15.3）：
// IO / resize / CJK / 洪流 seq 连续性 / 中断 / detach 期间 ring 续传 /
// 模拟 daemon 重启（注册目录扫描 + reattach）/ EOF 退出 / close 收尾清理。
// 用法：node scripts/smoke-pty.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnPtyHost,
  reattachPtyHost,
  listPtyHosts,
} from "../daemon/src/pty-adapter.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostBin = join(repo, "dist", "pty-host", "dev", "cxx-pty-host");
const base = mkdtempSync(join(tmpdir(), "cxx-pty-smoke-"));

const SHELL_SPEC = {
  executable: "/bin/zsh",
  args: ["-f"],
  cwd: base,
  env: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: base,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  },
  cols: 80,
  rows: 24,
  meta: { title: "smoke" },
};

let passed = 0;
let failed = 0;
const cleanups = [];

function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
}

// 终端会话观察器：累积输出、跟踪 seq 连续性、等待标记
function observe(client, hello, replayEndPromiseHolder = {}) {
  const st = { chunks: [], expected: null, seqGap: false, exit: null, replay: null };
  client.on("data", (seq, buf) => {
    if (st.expected !== null && seq !== st.expected) st.seqGap = true;
    st.expected = seq + buf.length;
    st.chunks.push(buf);
  });
  client.on("replayEnd", (r) => {
    st.replay = r;
    if (st.expected === null) st.expected = r.next;
    replayEndPromiseHolder.resolve?.(r);
  });
  client.on("exit", (e) => (st.exit = e));
  st.text = () => Buffer.concat(st.chunks);
  st.waitFor = (marker, ms = 8000) =>
    new Promise((resolve, reject) => {
      const needle = Buffer.from(marker, "utf8");
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (st.text().includes(needle)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - t0 > ms) {
          clearInterval(timer);
          reject(new Error(`timeout waiting ${JSON.stringify(marker)}`));
        }
      }, 30);
    });
  st.waitExit = (ms = 8000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (st.exit) {
          clearInterval(timer);
          resolve(st.exit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(timer);
          reject(new Error("timeout waiting exit"));
        }
      }, 30);
    });
  return st;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("build: go build → dist/pty-host/dev/cxx-pty-host");
  execFileSync("go", ["build", "-o", hostBin, "."], { cwd: join(repo, "pty-host") });

  // ---- 会话 1：交互主链路 ----
  console.log("session 1: 交互主链路");
  const dir1 = join(base, "term-1");
  const { client: c1, hello: h1 } = await spawnPtyHost({ hostBin, dir: dir1, spec: SHELL_SPEC });
  cleanups.push(() => c1.close());
  const s1 = observe(c1, h1);

  c1.write("echo hello-pty-$((6*7))\r");
  await s1.waitFor("hello-pty-42");
  ok("基础 IO：echo 往返");

  c1.write("echo 终端宽字符检查OK\r");
  await s1.waitFor("终端宽字符检查OK");
  ok("CJK/UTF-8 往返");

  c1.resize(100, 30);
  await sleep(150);
  c1.write("echo SIZE=$(stty size)\r");
  await s1.waitFor("SIZE=30 100");
  ok("resize 生效（stty size = 30 100）");

  // 标记一律用 $((...)) 计算值：命令回显只含表达式，执行输出才含值，
  // 避免 waitFor 被回显提前命中（kernel/ZLE 回显竞态）。
  c1.write("seq 1 20000; echo FLOOD-$((7*11))-END\r");
  await s1.waitFor("FLOOD-77-END", 20000);
  if (!s1.seqGap && s1.text().includes("\r\n19999\r\n20000")) ok("输出洪流：内容完整且 seq 连续");
  else fail("输出洪流", s1.seqGap ? "seq 不连续" : "内容缺失");

  c1.write("sleep 30 && echo NO-$((2*50))PE\r");
  await sleep(400);
  c1.signal("interrupt");
  c1.write("echo AFTER-$((3*9))-INT\r");
  await s1.waitFor("AFTER-27-INT");
  if (!s1.text().includes("NO-100PE")) ok("interrupt：sleep 被 Ctrl+C 打断");
  else fail("interrupt", "命令未被打断");

  // ---- detach 期间输出进 ring，reattach 无缝续传 ----
  c1.write("(sleep 0.5 && echo MARKER-$((5*5))-DETACHED) &\r");
  await sleep(100);
  const seqAtDetach = s1.expected;
  c1.disconnect();
  await sleep(1200); // host 无观察者期间，后台任务输出进 ring

  const { client: c1b } = await reattachPtyHost({ dir: dir1, sinceSeq: seqAtDetach });
  cleanups.push(() => c1b.close());
  const s1b = observe(c1b);
  await s1b.waitFor("MARKER-25-DETACHED");
  if (s1b.replay && !s1b.replay.gap) ok("detach→reattach：离线输出经 ring 无缝续传（无 gap）");
  else fail("detach→reattach", `replay=${JSON.stringify(s1b.replay)}`);

  // ---- 模拟 daemon 重启：只靠注册目录发现并恢复 ----
  console.log("session 1: 模拟 daemon 重启（注册目录扫描）");
  c1b.disconnect();
  await sleep(200);
  const found = listPtyHosts(base).filter((s) => s.alive);
  if (found.length === 1 && found[0].terminalId === "term-1" && found[0].meta?.title === "smoke") {
    ok("listPtyHosts：扫描到存活会话与元数据");
  } else {
    fail("listPtyHosts", JSON.stringify(found));
  }
  const { client: c1c, hello: h1c } = await reattachPtyHost({ dir: found[0].dir, sinceSeq: 0 });
  cleanups.push(() => c1c.close());
  const s1c = observe(c1c);
  await s1c.waitFor("MARKER-25-DETACHED"); // 全量 ring 重放含历史
  c1c.write("echo AFTER-$((4*8))-RESTART\r");
  await s1c.waitFor("AFTER-32-RESTART");
  if (h1c.childPid === h1.childPid) ok("daemon 重启恢复：同一子进程可继续输入");
  else fail("daemon 重启恢复", "childPid 变了");

  // ---- EOF 退出 ----
  c1c.signal("eof");
  const exit1 = await s1c.waitExit();
  if (exit1.code === 0) ok(`EOF：shell 正常退出（code=${exit1.code}）`);
  else fail("EOF 退出", JSON.stringify(exit1));

  // ---- 会话 2：close() 全链路清理 ----
  console.log("session 2: close 收尾");
  const dir2 = join(base, "term-2");
  const { client: c2 } = await spawnPtyHost({
    hostBin,
    dir: dir2,
    spec: { ...SHELL_SPEC, executable: "/bin/sleep", args: ["300"] },
  });
  const s2 = observe(c2);
  const [{ hostPid, childPid }] = listPtyHosts(base).filter(
    (s) => s.alive && s.terminalId === "term-2",
  );
  c2.close();
  await s2.waitExit();
  await sleep(1200); // host closing 路径：发完 EXIT 后自灭
  const hostGone = !pidAlive(hostPid);
  const childGone = !pidAlive(childPid);
  const sockGone = !existsSync(join(dir2, "sock"));
  const exitJson = existsSync(join(dir2, "exit.json"));
  if (hostGone && childGone && sockGone && exitJson) {
    ok("close：子进程终止、host 自灭、sock 清理、exit.json 留存");
  } else {
    fail("close 清理", `hostGone=${hostGone} childGone=${childGone} sockGone=${sockGone} exitJson=${exitJson}`);
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

main()
  .catch((err) => {
    console.error(`\nFAIL: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {}
    }
    await sleep(300);
    // 兜底：杀掉所有残留 host（负 pid 不可用——host 是各自 session leader，逐个 kill）
    for (const s of listPtyHosts(base)) {
      try {
        process.kill(s.hostPid, "SIGKILL");
      } catch {}
      try {
        process.kill(s.childPid, "SIGKILL");
      } catch {}
    }
    rmSync(base, { recursive: true, force: true });
  });
