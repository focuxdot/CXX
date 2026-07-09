// 常驻进程写路径的生命周期测试:进程复用 / options 变化重启 / 温和中断 / 崩溃收尾。
// 假 claude 桩生成到临时目录再执行——不能作为 .mjs 放进 test/:node --test 无参数运行时
// 会把 test/ 下所有 .mjs 当测试文件执行,常驻读 stdin 的桩会把整个 runner 挂死。
// CLAUDE_CONFIG_DIR 指到临时目录,避免碰真实会话。
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// 模拟 claude CLI 的 stream-json 双向模式,只讲 claude-backend 需要的方言。
// FAKE_MODE: ok(默认,出 delta 后 30ms 出 result) / hang(只出 delta 等 interrupt) / crash(收到消息即退出)
// FAKE_LOG: 每次启动追加一行 "spawn <pid>",测试用它数冷启动次数
const FAKE_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, \`spawn \${process.pid}\\n\`);
const out = (o) => process.stdout.write(\`\${JSON.stringify(o)}\\n\`);
const mode = process.env.FAKE_MODE || "ok";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "user") {
      if (mode === "crash") process.exit(3);
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } } });
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "llo" } } });
      if (mode === "hang") continue;
      setTimeout(() => out({ type: "result", subtype: "success", is_error: false }), 30);
    } else if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      out({ type: "result", subtype: "error_during_execution", is_error: true });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let tmp;
let FAKE;
let logPath;
let ClaudeBackend;

test.before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "cxx-cb-"));
  FAKE = path.join(tmp, "fake-claude.mjs");
  writeFileSync(FAKE, FAKE_SOURCE);
  chmodSync(FAKE, 0o755);
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude-home");
  ({ ClaudeBackend } = await import("../daemon/src/claude-backend.mjs"));
});
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function makeBackend(mode = "ok") {
  logPath = path.join(tmp, `spawns-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(logPath, "");
  process.env.FAKE_LOG = logPath;
  process.env.FAKE_MODE = mode;
  // archivePath 指进 tmp:pidfile 等落盘副产物不污染真实 ~/.cxx
  const backend = new ClaudeBackend({ command: FAKE, log: () => {}, archivePath: path.join(tmp, "archive.json") });
  const events = [];
  const waiters = [];
  backend.onNotification = (method, params) => {
    events.push({ method, params });
    for (const w of [...waiters]) w();
  };
  const waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    let timer = null;
    const check = () => {
      const hit = events.find(pred);
      if (!hit) return;
      clearTimeout(timer);
      const i = waiters.indexOf(check);
      if (i >= 0) waiters.splice(i, 1);
      resolve(hit);
    };
    timer = setTimeout(() => {
      const i = waiters.indexOf(check);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error(`超时未等到事件,已收到: ${events.map((e) => e.method).join(",") || "(无)"}`));
    }, ms);
    waiters.push(check);
    check();
  });
  const spawnCount = () => readFileSync(logPath, "utf8").split("\n").filter((l) => l.startsWith("spawn")).length;
  return { backend, events, waitFor, spawnCount };
}

const tid = () => globalThis.crypto.randomUUID();

test("连续两轮复用同一进程,收到打字 delta 与 turn/completed", async () => {
  const { backend, events, waitFor, spawnCount } = makeBackend("ok");
  const threadId = tid();
  await backend.startTurn(threadId, "hi");
  await waitFor((e) => e.method === "turn/completed");
  const deltas = events.filter((e) => e.method === "agent_message_delta");
  assert.ok(deltas.length >= 1, "应收到合并后的打字 delta");
  assert.equal(deltas.map((e) => e.params.delta).join(""), "hello");
  assert.equal(deltas[0].params.threadId, threadId);

  events.length = 0;
  await backend.startTurn(threadId, "again");
  await waitFor((e) => e.method === "turn/completed");
  assert.equal(spawnCount(), 1, "同 options 的第二轮应复用进程,不再冷启动");
  backend.stop();
});

test("options 变化触发重启,新进程生效", async () => {
  const { backend, waitFor, spawnCount } = makeBackend("ok");
  const threadId = tid();
  await backend.startTurn(threadId, "hi");
  await waitFor((e) => e.method === "turn/completed");
  await backend.startTurn(threadId, "hi", { model: "claude-opus-4-8" });
  await waitFor((e) => e.method === "turn/completed" && spawnCount() === 2);
  assert.equal(spawnCount(), 2, "换模型应重启进程");
  backend.stop();
});

test("温和中断:control_request 确认,轮次收为 turn/aborted,进程存活可续用", async () => {
  const { backend, events, waitFor, spawnCount } = makeBackend("hang");
  const threadId = tid();
  await backend.startTurn(threadId, "hi");
  await waitFor((e) => e.method === "agent_message_delta");
  await backend.interruptTurn(threadId);
  await waitFor((e) => e.method === "turn/aborted");
  assert.ok(!events.some((e) => e.method === "turn/failed"), "温和中断不应报 failed");
  // 中断后同进程还能接下一轮(hang 模式只出 delta,验证到 delta 即可)
  events.length = 0;
  await backend.startTurn(threadId, "next");
  await waitFor((e) => e.method === "agent_message_delta");
  assert.equal(spawnCount(), 1, "中断后应复用同一进程");
  backend.stop();
});

test("进程崩溃:轮次收为 turn/failed,下一轮自动重拉", async () => {
  const { backend, waitFor, spawnCount } = makeBackend("crash");
  const threadId = tid();
  await backend.startTurn(threadId, "hi");
  await waitFor((e) => e.method === "turn/failed");
  process.env.FAKE_MODE = "ok"; // 桩恢复正常,验证重拉路径
  await backend.startTurn(threadId, "hi");
  await waitFor((e) => e.method === "turn/completed");
  assert.equal(spawnCount(), 2, "崩溃后下一轮应重新拉起进程");
  backend.stop();
});

test("并发轮次拒绝:同会话进行中再发报错", async () => {
  const { backend, waitFor } = makeBackend("hang");
  const threadId = tid();
  await backend.startTurn(threadId, "hi");
  await assert.rejects(() => backend.startTurn(threadId, "again"), /已有进行中的轮次/);
  await backend.interruptTurn(threadId);
  await waitFor((e) => e.method === "turn/aborted");
  backend.stop();
});

test("并发竞态:同会话两个 startTurn 同时发起,只 spawn 一个进程", async () => {
  const { backend, waitFor, spawnCount } = makeBackend("ok");
  const threadId = tid();
  // 不 await 第一个——两个调用都停在 startTurn 内部的异步间隙,守卫必须同步占位才能拦住
  const results = await Promise.allSettled([
    backend.startTurn(threadId, "a"),
    backend.startTurn(threadId, "b"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "恰好一个成功");
  assert.equal(bad.length, 1, "另一个被并发守卫拒绝");
  assert.match(bad[0].reason.message, /已有进行中的轮次/);
  await waitFor((e) => e.method === "turn/completed");
  assert.equal(spawnCount(), 1, "只允许 spawn 一个进程,不能出现失踪的双胞胎");
  backend.stop();
});

test("pidfile:轮次期间记录属主与 pid,stop() 后清除", async () => {
  const { backend, waitFor } = makeBackend("ok");
  const threadId = tid();
  await backend.startTurn(threadId, "hi");
  const pidFile = path.join(tmp, "claude-pids.json");
  const rec = JSON.parse(readFileSync(pidFile, "utf8"));
  assert.equal(rec.daemon, process.pid, "pidfile 记录属主 daemon 的 pid");
  assert.ok(Array.isArray(rec.pids) && rec.pids.length === 1, "记录了在跑的子进程 pid");
  await waitFor((e) => e.method === "turn/completed");
  backend.stop();
  assert.throws(() => readFileSync(pidFile), "干净退出必须清掉 pidfile,否则每次重启都当崩溃残留收割");
});
