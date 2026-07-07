#!/usr/bin/env node
// 端到端冒烟（Claude agent 路径）：relay + daemon（含 Claude 后端）+ 模拟客户端。
// 验证：agents.list 含 claude -> sessions.list?agent=claude -> session.watch 快照。
// 需要本机装有 claude（Claude Code CLI）并有历史会话（~/.claude/projects）。
// 用法：node scripts/smoke-claude.mjs [--relay wss://...]
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createRelayServer } from "../relay/node/server.mjs";
import { issuePairToken, loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import { startDaemon } from "../daemon/src/main.mjs";
import { deriveSessionKey, exportPublicKeyRaw, open, seal } from "../daemon/src/crypto.mjs";

const { values } = parseArgs({ options: {
  relay: { type: "string" },
  write: { type: "boolean" },
  approve: { type: "boolean" },
  cancel: { type: "boolean" }, // 审批撤回：挂起审批时打断轮次 -> 卡片消失（修复 #2）
  plan: { type: "boolean" }, // plan 模式：假 claude 记录 spawn 参数（修复 #1，不打真实 API）
} });
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (m) => console.log(`✓ ${m}`);

let relay = null;
let relayUrl = values.relay ?? null;
if (relayUrl) ok(`使用外部 relay: ${relayUrl}`);
else {
  relay = createRelayServer();
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  ok(`relay 启动: ${relayUrl}`);
}

const dir = mkdtempSync(join(tmpdir(), "czr-claude-"));
const configPath = join(dir, "daemon.json");
const config = loadOrCreateConfig(configPath);
config.relayUrl = relayUrl;
config.appServerPort = 20000 + Math.floor(Math.random() * 20000);
saveConfig(configPath, config);

const daemon = await startDaemon({ configPath });
ok("daemon 启动");
const pairToken = issuePairToken(configPath, loadOrCreateConfig(configPath));

const clientKeys = generateKeyPairSync("x25519");
const sessionKey = deriveSessionKey(
  clientKeys.privateKey,
  Buffer.from(config.publicKey, "base64"),
  config.daemonId,
);
const ws = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
const inbox = [];
const waiting = [];
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.t !== "msg") return;
  const message = open(sessionKey, "d2c", frame.data);
  const waiter = waiting.shift();
  if (waiter) waiter(message);
  else inbox.push(message);
};
function nextMessage(timeoutMs = 15000) {
  if (inbox.length > 0) return Promise.resolve(inbox.shift());
  return new Promise((resolve, reject) => {
    waiting.push(resolve);
    setTimeout(() => reject(new Error("等待响应超时")), timeoutMs).unref?.();
  });
}
async function replyFor(id, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const msg = await nextMessage();
    if (msg.id === id) return msg;
  }
  fail(`等不到 id=${id} 的应答`);
}
let sentFirst = false;
function send(payload) {
  const envelope = seal(sessionKey, "c2d", payload);
  if (!sentFirst) {
    envelope.v = 1;
    envelope.k = exportPublicKeyRaw(clientKeys.publicKey).toString("base64");
    sentFirst = true;
  }
  ws.send(JSON.stringify({ t: "msg", data: envelope }));
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("client 无法连接 relay"));
});

// 1. 配对
send({ id: 1, method: "auth", params: { pairToken } });
if (!(await replyFor(1)).result?.deviceToken) fail("配对失败");
ok("配对成功");

// 2. agents.list 含 claude
send({ id: 2, method: "agents.list", params: {} });
const agents = (await replyFor(2)).result?.agents ?? [];
const ids = agents.map((a) => a.id);
if (!ids.includes("codex")) fail(`agents.list 缺 codex: ${JSON.stringify(agents)}`);
if (!ids.includes("claude")) fail(`agents.list 缺 claude（claude 未安装？）: ${JSON.stringify(agents)}`);
ok(`agents.list = ${agents.map((a) => `${a.name}(${a.healthy ? "healthy" : "down"})`).join(", ")}`);

// 3. sessions.list?agent=claude
send({ id: 3, method: "sessions.list", params: { agent: "claude", limit: 5 } });
const listRes = (await replyFor(3)).result;
if (listRes?.agent !== "claude") fail(`回帧 agent 标记错误: ${listRes?.agent}`);
const sessions = listRes?.sessions ?? [];
if (sessions.length === 0) fail("claude sessions.list 为空（~/.claude/projects 无会话？）");
ok(`claude sessions.list 返回 ${sessions.length} 条`);
console.log(`  最新: name=${JSON.stringify(sessions[0].name)} cwd=${sessions[0].cwd}`);
console.log(`        preview=${JSON.stringify((sessions[0].preview || "").slice(0, 50))}`);

// 4. 校验 codex 与 claude 列表不同源（sessionId 集合应不相交）
send({ id: 4, method: "sessions.list", params: { agent: "codex", limit: 5 } });
const codexSessions = (await replyFor(4)).result?.sessions ?? [];
const claudeIds = new Set(sessions.map((s) => s.id));
const overlap = codexSessions.filter((s) => claudeIds.has(s.id)).length;
ok(`codex 列表 ${codexSessions.length} 条，与 claude 交集 ${overlap}（应为 0）`);

// 5. watch 一个 claude 会话，拿到快照（原始 claude 条目）
send({ id: 5, method: "session.watch", params: { agent: "claude", sessionId: sessions[0].id } });
let snapshot = null;
for (let i = 0; i < 8; i++) {
  const msg = await nextMessage();
  if (msg.method === "session.snapshot") { snapshot = msg; break; }
  if (msg.id === 5 && msg.error) fail(`watch 失败: ${JSON.stringify(msg.error)}`);
}
if (!snapshot) fail("未收到 claude session.snapshot");
const items = snapshot.params.items ?? [];
ok(`claude session.watch 快照 ${items.length} 条`);
const types = [...new Set(items.map((it) => it.type))];
console.log(`  条目 type: ${types.join(", ")}`);
const hasClaudeShape = items.some((it) => it.type === "assistant" || it.type === "user");
if (!hasClaudeShape) fail("快照条目不是 claude 形状（缺 user/assistant）");
ok("快照条目为原始 claude 形状（含 user/assistant，供 web 独立渲染路径消费）");

// 5.5 Claude 围观路径：share.create/list 必须按 agent 路由；viewer scope 也要记住 agent。
send({ id: 6, method: "share.create", params: { agent: "claude", sessionId: sessions[0].id, ttl: "24h" } });
const created = (await replyFor(6)).result;
if (!created?.url?.includes("#d=")) fail(`share.create(claude) 失败: ${JSON.stringify(created)}`);
const viewerPayload = JSON.parse(Buffer.from(created.url.split("#d=")[1], "base64url").toString());
if (viewerPayload.ro !== 1 || viewerPayload.sid !== sessions[0].id || viewerPayload.agent !== "claude") {
  fail(`Claude 围观链接载荷缺 ro/sid/agent: ${JSON.stringify(viewerPayload)}`);
}
ok("share.create(claude) 生成带 agent=claude 的围观链接");

send({ id: 7, method: "share.list", params: { agent: "claude", sessionId: sessions[0].id } });
const links = (await replyFor(7)).result?.links ?? [];
if (!links.some((l) => l.deviceId === created.deviceId && l.url === created.url)) {
  fail(`share.list(claude) 未返回刚创建的链接: ${JSON.stringify(links)}`);
}
ok("share.list(claude) 命中 Claude 会话的围观链接");

const vKeys = generateKeyPairSync("x25519");
const vKey = deriveSessionKey(vKeys.privateKey, Buffer.from(config.publicKey, "base64"), config.daemonId);
const vws = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
const vInbox = [];
const vWaiting = [];
vws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.t !== "msg") return;
  const message = open(vKey, "d2c", frame.data);
  const waiter = vWaiting.shift();
  if (waiter) waiter(message);
  else vInbox.push(message);
};
function vNext(timeoutMs = 15000) {
  if (vInbox.length > 0) return Promise.resolve(vInbox.shift());
  return new Promise((resolve, reject) => {
    vWaiting.push(resolve);
    setTimeout(() => reject(new Error("等待 Claude 观众端响应超时")), timeoutMs).unref?.();
  });
}
let vFirst = false;
function vSend(payload) {
  const envelope = seal(vKey, "c2d", payload);
  if (!vFirst) {
    envelope.v = 1;
    envelope.k = exportPublicKeyRaw(vKeys.publicKey).toString("base64");
    vFirst = true;
  }
  vws.send(JSON.stringify({ t: "msg", data: envelope }));
}
async function vReply(id, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const msg = await vNext();
    if (msg.id === id) return msg;
  }
  fail(`Claude 观众端等不到 id=${id} 的应答`);
}
await new Promise((resolve) => (vws.onopen = resolve));
vSend({ id: 1, method: "auth", params: { deviceToken: viewerPayload.dtok, name: "smoke claude viewer" } });
const vAuth = (await vReply(1)).result;
if (vAuth?.role !== "viewer" || vAuth?.scope?.sessionId !== sessions[0].id || vAuth?.scope?.agent !== "claude") {
  fail(`Claude 观众鉴权响应缺 role/scope.agent: ${JSON.stringify(vAuth)}`);
}
ok("Claude 观众鉴权返回 scope.agent=claude");

// 观众端不带 params.agent，daemon 也必须按链接 scope.agent 路由到 Claude hub。
vSend({ id: 2, method: "session.watch", params: { sessionId: sessions[0].id, fromStart: true } });
const vWatch = await vReply(2);
if (!vWatch.result?.ok) fail(`Claude 观众 watch 未按 scope.agent 路由: ${JSON.stringify(vWatch)}`);
ok("Claude 观众不带 agent 也能 watch 原会话");
vws.close();

// 6. 写入链路（--write，会真实调用 claude API）：新建 claude 会话 -> 发消息 -> 等完成
if (values.write) {
  const { mkdtempSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "czr-claude-cwd-"));
  send({ id: 10, method: "session.new", params: { agent: "claude", cwd } });
  const newRes = (await replyFor(10)).result;
  const threadId = newRes?.threadId;
  if (!threadId) fail(`session.new(claude) 失败: ${JSON.stringify(newRes)}`);
  ok(`新建 claude 会话: ${threadId.slice(0, 8)} @ ${cwd}`);

  send({ id: 11, method: "session.send", params: { agent: "claude", sessionId: threadId, text: "Reply with exactly: SMOKE-OK" } });
  if (!(await replyFor(11)).result?.turnId) fail("session.send(claude) 未返回 turnId");
  ok("session.send 已发起轮次");

  // 等 board.changed running=false（turn/completed 经 hub 广播）
  let done = false;
  for (let i = 0; i < 60; i++) {
    const msg = await nextMessage(60000);
    if (msg.method === "board.changed" && msg.params?.sessionId === threadId && msg.params.running === false) { done = true; break; }
  }
  if (!done) fail("未等到 claude 轮次完成（board.changed running=false）");
  const file = execSync(`find ~/.claude/projects -name "${threadId}.jsonl"`).toString().trim();
  const hit = file && execSync(`grep -c "SMOKE-OK" "${file}" || true`).toString().trim() !== "0";
  if (!hit) fail("助手回复未落入会话文件");
  ok("claude 轮次完成，助手回复已写入同一会话文件");
  execSync(`rm -f "${file}"`); // 清理测试会话
  rmSync(cwd, { recursive: true, force: true });
}

// 7. 审批链路（--approve，真实 API + 工具）：发一条要用 Bash 的消息 -> 收 approval.request
//    -> 回 approval.respond(accept, agent:claude) -> 轮次完成、命令执行。
if (values.approve) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "czr-claude-appr-"));
  writeFileSync(join(cwd, "secret.txt"), "E2E-APPROVAL-SECRET\n");
  send({ id: 20, method: "session.new", params: { agent: "claude", cwd } });
  const threadId = (await replyFor(20)).result?.threadId;
  if (!threadId) fail("session.new(claude) 失败");
  ok(`审批测试会话: ${threadId.slice(0, 8)}`);

  send({ id: 21, method: "session.send", params: { agent: "claude", sessionId: threadId, text: "Use the Bash tool to run: cat secret.txt, then report its contents." } });
  await replyFor(21);

  // 等 approval.request
  let appr = null;
  for (let i = 0; i < 80; i++) {
    const msg = await nextMessage(60000);
    if (msg.method === "approval.request" && msg.params?.sessionId === threadId) { appr = msg.params; break; }
  }
  if (!appr) fail("未收到 approval.request");
  if (appr.agent !== "claude") fail(`approval.request agent 标记错误: ${appr.agent}`);
  ok(`收到审批: agent=${appr.agent} kind=${appr.kind} command=${JSON.stringify((appr.command || "").slice(0, 30))}`);

  // 回帧必须带 agent:claude，才能路由到 claude hub
  send({ id: 22, method: "approval.respond", params: { agent: "claude", approvalKey: appr.approvalKey, decision: "accept" } });
  await replyFor(22);
  ok("已回 approval.respond(accept, agent=claude)");

  let done = false;
  for (let i = 0; i < 80; i++) {
    const msg = await nextMessage(60000);
    if (msg.method === "board.changed" && msg.params?.sessionId === threadId && msg.params.running === false) { done = true; break; }
  }
  if (!done) fail("审批后轮次未完成");
  const file = execSync(`find ~/.claude/projects -name "${threadId}.jsonl"`).toString().trim();
  const ran = file && execSync(`grep -c "E2E-APPROVAL-SECRET" "${file}" || true`).toString().trim() !== "0";
  if (!ran) fail("审批通过后命令未执行（机密未出现）");
  ok("审批通过 → 命令执行，机密内容已入会话文件");
  execSync(`rm -f "${file}"`);
  rmSync(cwd, { recursive: true, force: true });
}

// 8. 审批撤回（--cancel，真实 API + 工具）：发一条触发 Bash 审批的消息 -> 收到
//    approval.request 后不批准，直接 turn.interrupt -> 断言收到 approval.resolved。
//    正是修复 #2 的路径：轮次结束时后端撤回挂起审批，手机端卡片随之消失。
if (values.cancel) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "czr-claude-cancel-"));
  writeFileSync(join(cwd, "secret.txt"), "CANCEL-SECRET\n");
  send({ id: 30, method: "session.new", params: { agent: "claude", cwd } });
  const threadId = (await replyFor(30)).result?.threadId;
  if (!threadId) fail("session.new(claude) 失败（撤回测试）");
  ok(`撤回测试会话: ${threadId.slice(0, 8)}`);

  send({ id: 31, method: "session.send", params: { agent: "claude", sessionId: threadId, text: "Use the Bash tool to run: cat secret.txt, then report its contents." } });
  await replyFor(31);

  // 等审批出现（此时轮次挂起在 PreToolUse hook 上）
  let appr = null;
  for (let i = 0; i < 80; i++) {
    const msg = await nextMessage(60000);
    if (msg.method === "approval.request" && msg.params?.sessionId === threadId) { appr = msg.params; break; }
  }
  if (!appr) fail("未收到 approval.request（撤回测试）");
  ok(`收到待撤回审批: approvalKey=${appr.approvalKey}`);

  // 不批准，直接打断轮次。不等 id=32 应答（避免与 approval.resolved 的到达顺序竞争，
  // replyFor 会丢弃非匹配帧），直接扫 approval.resolved。
  send({ id: 32, method: "turn.interrupt", params: { agent: "claude", sessionId: threadId } });
  let resolved = null;
  for (let i = 0; i < 60; i++) {
    const msg = await nextMessage(60000);
    if (msg.method === "approval.resolved" && msg.params?.approvalKey === appr.approvalKey) { resolved = msg.params; break; }
  }
  if (!resolved) fail("打断后未收到 approval.resolved（审批卡片未撤回）");
  if (resolved.agent !== "claude") fail(`approval.resolved agent 标记错误: ${resolved.agent}`);
  ok("打断轮次 → 审批卡片自动撤回（approval.resolved, agent=claude，修复 #2）");

  // 机密不应入会话：审批被撤回、命令从未执行
  const file = execSync(`find ~/.claude/projects -name "${threadId}.jsonl"`).toString().trim();
  if (file) {
    const ran = execSync(`grep -c "CANCEL-SECRET" "${file}" || true`).toString().trim() !== "0";
    if (ran) fail("审批被撤回，命令却执行了（机密出现）");
    execSync(`rm -f "${file}"`);
  }
  ok("撤回后命令未执行（机密未入会话文件）");
  rmSync(cwd, { recursive: true, force: true });
}

// 9. plan 模式（--plan，不打真实 API）：用一个假 claude 记录 spawn 参数，验证
//    手机端 options:{plan:true} 经 hub 展开为 collaborationMode 后，backend 补上
//    --permission-mode plan（修复 #1）。直接搭 backend+hub，跳过 relay/客户端。
async function planModeTest() {
  const { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const { ClaudeBackend } = await import("../daemon/src/claude-backend.mjs");
  const { SessionHub } = await import("../daemon/src/session-hub.mjs");

  // 假 claude：--version 回一个够格版本（过版本门槛）；轮次调用把 argv 落文件后退出。
  const fakeDir = mkdtempSync(join(tmpdir(), "czr-fakeclaude-"));
  const argsFile = join(fakeDir, "args.txt");
  const fakeClaude = join(fakeDir, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
cat >/dev/null 2>&1
exit 0
`);
  chmodSync(fakeClaude, 0o755);

  const backend = new ClaudeBackend({ command: fakeClaude });
  await backend.start();
  const hub = new SessionHub(backend, { agent: "claude" });
  const waitArgs = async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(argsFile)) { const s = readFileSync(argsFile, "utf8"); if (s) return s.split("\n").filter(Boolean); }
      await new Promise((r) => setTimeout(r, 50).unref?.());
    }
    return [];
  };

  // 带 plan:true：hub 剥掉 plan 展开成 collaborationMode，backend 据此补 --permission-mode plan
  await hub.sendMessage(randomUUID(), "hi", [], { plan: true });
  const args = await waitArgs();
  const i = args.indexOf("--permission-mode");
  if (i < 0 || args[i + 1] !== "plan") fail(`plan 未生效：spawn 参数=${JSON.stringify(args)}`);
  ok("plan 模式 → claude 以 --permission-mode plan 启动（hub 展开 + backend 识别，修复 #1）");

  // 反证：不带 plan 应为默认模式，不应是 plan
  rmSync(argsFile, { force: true });
  await hub.sendMessage(randomUUID(), "hi", [], {});
  const args2 = await waitArgs();
  const j = args2.indexOf("--permission-mode");
  if (j >= 0 && args2[j + 1] === "plan") fail(`未带 plan 却启用了 plan 模式：${JSON.stringify(args2)}`);
  ok("未带 plan → 非 plan 模式，plan 开关精确生效");

  // 全权限 override：Codex 侧的 dangerFullAccess/approval never 要映射成 Claude bypass，
  // 并且不能再装 PreToolUse hook，否则表面是 full access，实际仍会弹审批。
  rmSync(argsFile, { force: true });
  await hub.sendMessage(randomUUID(), "hi", [], {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  const args3 = await waitArgs();
  const k = args3.indexOf("--permission-mode");
  if (k < 0 || args3[k + 1] !== "bypassPermissions") fail(`全权限未映射到 bypassPermissions：${JSON.stringify(args3)}`);
  if (args3.includes("--settings")) fail(`全权限仍安装了审批 hook：${JSON.stringify(args3)}`);
  ok("全权限 override → bypassPermissions 且不安装审批 hook");

  // workspace-write override：不应退回 default，否则 Claude 会继续忽略前端权限选择。
  rmSync(argsFile, { force: true });
  await hub.sendMessage(randomUUID(), "hi", [], {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" },
  });
  const args4 = await waitArgs();
  const m = args4.indexOf("--permission-mode");
  if (m < 0 || args4[m + 1] !== "acceptEdits") fail(`workspace-write 未映射到 acceptEdits：${JSON.stringify(args4)}`);
  if (!args4.includes("--settings")) fail(`workspace-write 缺少审批 hook：${JSON.stringify(args4)}`);
  ok("workspace-write override → acceptEdits 并保留审批 hook");

  backend.stop();
  rmSync(fakeDir, { recursive: true, force: true });
}
if (values.plan) await planModeTest();

console.log("\nClaude agent 端到端冒烟全部通过。");
daemon.stop();
ws.close();
relay?.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
