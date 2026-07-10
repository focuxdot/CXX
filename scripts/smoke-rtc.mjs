#!/usr/bin/env node
// 局域网直连端到端冒烟：relay + daemon（真实 codex app-server）+ 模拟客户端。
// 验证链路：中继配对鉴权 -> rtc.offer 信令 -> DataChannel 建通道 ->
//           直连通道上重新 E2E 握手 + deviceToken 鉴权 -> sessions.list / ping ->
//           中继通道断开后直连仍可用（直连独立于中继的核心承诺）
// 用法：node scripts/smoke-rtc.mjs [--codex <cmd>]
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
import werift from "../daemon/src/vendor/werift.cjs";

const { RTCPeerConnection } = werift;
const { values } = parseArgs({ options: { codex: { type: "string" } } });

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

// 1. 本地 relay + daemon（独立临时配置）
const relay = createRelayServer();
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
ok(`relay 启动: ${relayUrl}`);

const dir = mkdtempSync(join(tmpdir(), "czr-smoke-rtc-"));
const configPath = join(dir, "daemon.json");
const config = loadOrCreateConfig(configPath);
config.relayUrl = relayUrl;
config.appServerPort = 20000 + Math.floor(Math.random() * 20000);
if (values.codex) config.codexCommand = values.codex;
saveConfig(configPath, config);
const daemon = await startDaemon({ configPath });
ok("daemon 启动（codex app-server 就绪）");
const pairToken = issuePairToken(configPath, loadOrCreateConfig(configPath));

// 简易 E2E 信道封装（中继与直连共用；transportSend 决定走哪根管子）
function makeChannel(transportSend) {
  const keys = generateKeyPairSync("x25519");
  const key = deriveSessionKey(keys.privateKey, Buffer.from(config.publicKey, "base64"), config.daemonId);
  const inbox = [];
  const waiting = [];
  let first = false;
  return {
    key,
    onEnvelope(envelope) {
      const message = open(key, "d2c", envelope);
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    },
    send(payload) {
      const envelope = seal(key, "c2d", payload);
      if (!first) {
        envelope.v = 1;
        envelope.k = exportPublicKeyRaw(keys.publicKey).toString("base64");
        first = true;
      }
      transportSend(envelope);
    },
    next(timeoutMs = 15000) {
      if (inbox.length > 0) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        waiting.push(resolve);
        setTimeout(() => reject(new Error("等待响应超时")), timeoutMs).unref?.();
      });
    },
    async replyFor(id, tries = 30) {
      for (let i = 0; i < tries; i++) {
        const msg = await this.next();
        if (msg.id === id) return msg;
      }
      fail(`等不到 id=${id} 的应答`);
    },
  };
}

// 2. 中继通道：配对鉴权，确认 daemon 广播 rtc 能力
const ws = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
const relayChan = makeChannel((envelope) => ws.send(JSON.stringify({ t: "msg", data: envelope })));
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.t === "msg") relayChan.onEnvelope(frame.data);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("client 无法连接 relay"));
});
relayChan.send({ id: 1, method: "auth", params: { pairToken } });
const auth = (await relayChan.replyFor(1)).result;
if (!auth?.deviceToken) fail(`配对失败: ${JSON.stringify(auth)}`);
if (auth.caps?.rtc !== 1) fail(`auth 应答未广播 rtc 能力: ${JSON.stringify(auth.caps)}`);
ok(`中继配对成功，daemon 声明 caps.rtc=1`);

// 3. 直连信令：vanilla ICE offer 经中继 E2E 信道交换
const pc = new RTCPeerConnection({ iceServers: [], maxMessageSize: 256 * 1024 });
const dc = pc.createDataChannel("cxx");
await pc.setLocalDescription(await pc.createOffer());
await new Promise((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  const cap = setTimeout(resolve, 1500);
  pc.iceGatheringStateChange.subscribe((s) => {
    if (s === "complete") { clearTimeout(cap); resolve(); }
  });
});
relayChan.send({ id: 2, method: "rtc.offer", params: { type: "offer", sdp: pc.localDescription.sdp } });
const answer = (await relayChan.replyFor(2)).result;
if (answer?.type !== "answer" || !answer.sdp) fail(`rtc.offer 应答非法: ${JSON.stringify(answer)}`);
await pc.setRemoteDescription(answer);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("DataChannel 未在 10s 内打开")), 10_000);
  dc.stateChanged.subscribe((s) => {
    if (s === "open") { clearTimeout(timer); resolve(); }
  });
  if (dc.readyState === "open") { clearTimeout(timer); resolve(); }
});
ok("DataChannel 已打开（信令单次往返，vanilla ICE）");

// 4. 直连通道上重新 E2E 握手 + deviceToken 鉴权（裸信封，无 {t:"msg"} 包装）
const rtcChan = makeChannel((envelope) => dc.send(JSON.stringify(envelope)));
dc.onMessage.subscribe((raw) => rtcChan.onEnvelope(JSON.parse(String(raw))));
rtcChan.send({ id: 1, method: "auth", params: { deviceToken: auth.deviceToken, name: "smoke 直连" } });
const rtcAuth = (await rtcChan.replyFor(1)).result;
if (!rtcAuth?.deviceId) fail(`直连鉴权失败: ${JSON.stringify(rtcAuth)}`);
if (rtcAuth.deviceId !== auth.deviceId) fail("直连鉴权归并到了不同设备");
ok(`直连通道鉴权成功（同一设备 ${rtcAuth.deviceId}）`);

// 5. 直连数据面：sessions.list + ping/pong
rtcChan.send({ id: 2, method: "sessions.list", params: { limit: 5 } });
const list = (await rtcChan.replyFor(2)).result;
if (!Array.isArray(list?.sessions)) fail(`直连 sessions.list 失败: ${JSON.stringify(list)}`);
ok(`直连 sessions.list 返回 ${list.sessions.length} 个会话`);
rtcChan.send({ method: "ping" });
const pong = await rtcChan.next();
if (pong.method !== "pong") fail(`ping 未得 pong: ${JSON.stringify(pong)}`);
ok("直连 ping/pong 正常");

// 6. 中继断开后直连仍可用（外网抖断场景的核心承诺）
ws.close();
await new Promise((resolve) => setTimeout(resolve, 500));
rtcChan.send({ id: 3, method: "sessions.list", params: { limit: 1 } });
const afterClose = (await rtcChan.replyFor(3)).result;
if (!Array.isArray(afterClose?.sessions)) fail("中继断开后直连请求失败");
ok("中继通道断开后，直连数据面照常工作");

// 收尾
try { pc.close(); } catch {}
daemon.stop();
relay.close();
rmSync(dir, { recursive: true, force: true });
ok("smoke-rtc 全部通过");
process.exit(0);
