#!/usr/bin/env node
// 端到端冒烟：relay + daemon（真实 codex app-server）+ 模拟客户端
// 验证链路：配对握手 -> E2E 加密 -> sessions.list -> session.watch 快照
// 用法：node remote/scripts/smoke.mjs [--codex <cmd>] [--relay wss://...]
//   默认在本地拉起 relay-node；--relay 指定外部实例（如线上 wss://relay.wokey.ai）
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

const { values } = parseArgs({
  options: { codex: { type: "string" }, relay: { type: "string" } },
});

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

// 1. relay：默认本地拉起，--relay 时用外部实例
let relay = null;
let relayUrl = values.relay ?? null;
if (relayUrl) {
  ok(`使用外部 relay: ${relayUrl}`);
} else {
  relay = createRelayServer();
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  ok(`relay 启动: ${relayUrl}`);
}

// 2. daemon（独立临时配置，不碰真实 ~/.cxx）
const dir = mkdtempSync(join(tmpdir(), "czr-smoke-"));
const configPath = join(dir, "daemon.json");
const config = loadOrCreateConfig(configPath);
config.relayUrl = relayUrl;
config.appServerPort = 20000 + Math.floor(Math.random() * 20000);
if (values.codex) config.codexCommand = values.codex;
saveConfig(configPath, config);

const daemon = await startDaemon({ configPath });
ok(`daemon 启动（codex app-server 就绪）`);
const pairToken = issuePairToken(configPath, loadOrCreateConfig(configPath));

// 3. 模拟手机客户端
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
  if (frame.t === "status") return;
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
let sentFirst = false;
function send(payload) {
  const envelope = seal(sessionKey, "c2d", payload);
  if (!sentFirst) {
    envelope.v = 1;
    envelope.k = exportPublicKeyRaw(clientKeys.publicKey).toString("base64");
    envelope.zc = 1; // 声明能 inflate：让 daemon 压缩大帧，冒烟覆盖压缩往返（open 自动解压）
    sentFirst = true;
  }
  ws.send(JSON.stringify({ t: "msg", data: envelope }));
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("client 无法连接 relay"));
});
ok("client 连接 relay");

// 4. 配对鉴权
send({ id: 1, method: "auth", params: { pairToken } });
const authResult = await nextMessage();
if (!authResult.result?.deviceToken) fail(`配对失败: ${JSON.stringify(authResult)}`);
if (authResult.result?.caps?.wl !== 1) fail("daemon 未声明 watch lease 能力");
ok(`配对成功: deviceId=${authResult.result.deviceId} daemon=${authResult.result.daemonName}`);

// 5. 会话列表
send({ id: 2, method: "sessions.list", params: { limit: 5 } });
const listResult = await nextMessage();
const sessions = listResult.result?.sessions ?? [];
ok(`sessions.list 返回 ${sessions.length} 个会话`);
if (sessions.length > 0) {
  console.log(`  最近会话: ${(sessions[0].name || sessions[0].preview || "").slice(0, 60)}`);

  // 6. 实时查看快照
  send({
    id: 3,
    method: "session.watch",
    params: { sessionId: sessions[0].id, wt: "smoke-watch", leaseMs: 60000 },
  });
  let snapshot = null;
  for (let i = 0; i < 5; i++) {
    const msg = await nextMessage();
    if (msg.method === "session.snapshot") {
      snapshot = msg;
      break;
    }
  }
  if (!snapshot) fail("未收到 session.snapshot");
  ok(`session.watch 快照 ${snapshot.params.items.length} 条`);

  // 6.5 围观路径：铸造只读链接 -> 观众连入 -> 越权矩阵 -> 撤销即踢
  // watch 之后信道里会穿插 tail/看板通知，等应答必须按 id 扫描
  async function replyFor(id, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await nextMessage(Math.max(1, deadline - Date.now()));
      if (msg.id === id) return msg;
    }
    fail(`等不到 id=${id} 的应答`);
  }
  send({ id: 40, method: "session.watch.renew", params: { wt: "smoke-watch" } });
  if (!(await replyFor(40)).result?.ok) fail("session.watch.renew 失败");
  ok("session.watch 租约续期成功");
  send({ id: 41, method: "session.unwatch", params: { wt: "stale-smoke-watch" } });
  if (!(await replyFor(41)).result?.stale) fail("旧 wt 的 session.unwatch 未被安全忽略");
  send({ id: 42, method: "session.watch.renew", params: { wt: "smoke-watch" } });
  if (!(await replyFor(42)).result?.ok) fail("旧 unwatch 误停了当前 watch");
  ok("迟到的旧 session.unwatch 不会误停新 watch");
  send({ id: 4, method: "share.create", params: { sessionId: sessions[0].id, ttl: "24h" } });
  const created = (await replyFor(4)).result;
  if (!created?.url?.includes("#d=")) fail(`share.create 失败: ${JSON.stringify(created)}`);
  const viewerPayload = JSON.parse(
    Buffer.from(created.url.split("#d=")[1], "base64url").toString(),
  );
  if (viewerPayload.ro !== 1 || viewerPayload.sid !== sessions[0].id) fail("围观载荷缺少 ro/sid 提示字段");
  ok(`share.create 铸造围观链接: deviceId=${created.deviceId}`);

  // 观众连接（独立 E2E 信道）
  const vKeys = generateKeyPairSync("x25519");
  const vKey = deriveSessionKey(vKeys.privateKey, Buffer.from(config.publicKey, "base64"), config.daemonId);
  const vws = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
  const vInbox = [];
  const vWaiting = [];
  let vClosed = false;
  vws.onclose = () => { vClosed = true; };
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
      setTimeout(() => reject(new Error("等待观众端响应超时")), timeoutMs).unref?.();
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
  async function vReply(id, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await vNext(Math.max(1, deadline - Date.now()));
      if (msg.id === id) return msg;
    }
    fail(`观众端等不到 id=${id} 的应答`);
  }
  await new Promise((resolve) => (vws.onopen = resolve));
  vSend({ id: 1, method: "auth", params: { deviceToken: viewerPayload.dtok, name: "smoke 观众" } });
  const vAuth = (await vReply(1)).result;
  if (vAuth?.role !== "viewer" || vAuth?.scope?.sessionId !== sessions[0].id) {
    fail(`观众鉴权响应缺 role/scope: ${JSON.stringify(vAuth)}`);
  }
  if (vAuth?.caps?.wl !== 1) fail("观众鉴权未声明 watch lease 能力");
  ok("观众鉴权成功（role=viewer，scope 正确）");

  // 越权矩阵：全部 403
  let vid = 2;
  for (const [method, params] of [
    ["sessions.list", { limit: 5 }],
    ["session.send", { sessionId: sessions[0].id, text: "hack" }],
    ["approval.respond", { approvalKey: "a1", decision: "accept" }],
    ["session.new", {}],
    ["session.start", { text: "hack" }],
    ["share.create", { sessionId: sessions[0].id, ttl: null }],
  ]) {
    vSend({ id: vid, method, params });
    const r = await vReply(vid);
    if (r.error?.code !== 403) fail(`观众越权 ${method} 未被拒绝: ${JSON.stringify(r)}`);
    vid++;
  }
  ok("观众越权方法一律 403");

  // 本会话可看
  vSend({
    id: vid,
    method: "session.watch",
    params: { sessionId: sessions[0].id, fromStart: true, wt: "viewer-smoke-watch", leaseMs: 60000 },
  });
  const vWatch = await vReply(vid);
  if (!vWatch.result?.ok) fail(`观众 watch 本会话失败: ${JSON.stringify(vWatch)}`);
  ok(`观众可看本会话（mode=${vWatch.result.mode ?? "tail"}）`);
  vid++;
  vSend({ id: vid, method: "session.watch.renew", params: { wt: "viewer-smoke-watch" } });
  if (!(await vReply(vid)).result?.ok) fail("观众 session.watch.renew 失败");
  vid++;

  // 喝彩：观众 share.react -> 双端收到聚合广播 share.reaction
  vSend({ id: vid, method: "share.react", params: { emoji: "👏" } });
  const reacted = await vReply(vid);
  if (!reacted.result?.ok) fail(`share.react 失败: ${JSON.stringify(reacted)}`);
  vid++;
  const reactionDeadline = Date.now() + 5000;
  let gotReaction = false;
  while (!gotReaction && Date.now() < reactionDeadline) {
    const msg = await nextMessage(3000).catch(() => null);
    if (!msg) break;
    if (msg.method === "share.reaction" && msg.params.emoji === "👏" && msg.params.count >= 1) {
      gotReaction = true;
    }
  }
  if (!gotReaction) fail("全权设备未收到 share.reaction 聚合广播");
  ok("喝彩聚合广播到达分享者");

  // 撤销即踢：全权设备 share.revoke 后观众连接立即断开
  send({ id: 5, method: "share.list", params: { sessionId: sessions[0].id } });
  const links = (await replyFor(5)).result?.links ?? [];
  if (!links.some((l) => l.deviceId === created.deviceId && l.url === created.url)) {
    fail("share.list 未返回刚铸造的链接");
  }
  ok(`share.list 返回 ${links.length} 条围观链接`);
  send({ id: 6, method: "share.revoke", params: { deviceId: created.deviceId } });
  const revoked = await replyFor(6);
  if (!revoked.result?.ok) fail(`share.revoke 失败: ${JSON.stringify(revoked)}`);
  const kickDeadline = Date.now() + 8000;
  while (!vClosed && Date.now() < kickDeadline) await new Promise((r) => setTimeout(r, 100));
  if (!vClosed) fail("撤销后观众连接未被踢断");
  ok("撤销围观链接：在线观众连接立即断开");
}

// 7. 错误路径：错误配对码必须被拒绝
const badKeys = generateKeyPairSync("x25519");
const badKey = deriveSessionKey(
  badKeys.privateKey,
  Buffer.from(config.publicKey, "base64"),
  config.daemonId,
);
const ws2 = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
await new Promise((resolve) => (ws2.onopen = resolve));
const rejection = await new Promise((resolve, reject) => {
  ws2.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === "msg") resolve(open(badKey, "d2c", frame.data));
  };
  const envelope = seal(badKey, "c2d", { id: 1, method: "auth", params: { pairToken: "wrong" } });
  envelope.v = 1;
  envelope.k = exportPublicKeyRaw(badKeys.publicKey).toString("base64");
  ws2.send(JSON.stringify({ t: "msg", data: envelope }));
  setTimeout(() => reject(new Error("等待拒绝超时")), 10000).unref?.();
});
if (!rejection.error) fail("错误配对码未被拒绝");
ok(`错误配对码被拒绝: ${rejection.error.message}`);

console.log("\n端到端冒烟全部通过。");
ws.close();
ws2.close();
daemon.stop();
relay?.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
