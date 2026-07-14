#!/usr/bin/env node
// Terminal Mode 协议级端到端冒烟：relay + 真实 daemon + 模拟手机客户端。
// 覆盖单元/集成冒烟测不到的部分：E2E 信封里的 terminal.* 路由、caps 声明、
// 权限链（terminalEnabled + device.terminalAccess + 热更新生效）、
// snapshot/output 通知帧经 LOW 队列送达、exited 帧。
// 用法：node scripts/smoke-terminal-e2e.mjs
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { createRelayServer } from "../relay/node/server.mjs";
import { issuePairToken, loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import { startDaemon } from "../daemon/src/main.mjs";
import { deriveSessionKey, exportPublicKeyRaw, open, seal } from "../daemon/src/crypto.mjs";
import { listPtyHosts } from "../daemon/src/pty-adapter.mjs";

let passed = 0;
let failed = 0;
const ok = (n) => (passed++, console.log(`  ✅ ${n}`));
const fail = (n, d) => (failed++, console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 本地 relay
const relay = createRelayServer();
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
console.log(`relay: ${relayUrl}`);

// 2. daemon（独立临时配置；terminalEnabled 开）
const dir = mkdtempSync(join(tmpdir(), "cxx-term-e2e-"));
const configPath = join(dir, "daemon.json");
const config = loadOrCreateConfig(configPath);
config.relayUrl = relayUrl;
config.appServerPort = 20000 + Math.floor(Math.random() * 20000);
config.terminalEnabled = true;
saveConfig(configPath, config);
const daemon = await startDaemon({ configPath });
console.log("daemon 就绪");
const pairToken = issuePairToken(configPath, loadOrCreateConfig(configPath));

// 3. 模拟客户端
const clientKeys = generateKeyPairSync("x25519");
const sessionKey = deriveSessionKey(clientKeys.privateKey, Buffer.from(config.publicKey, "base64"), config.daemonId);
const ws = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
const inbox = []; // 全部 d2c 消息（应答 + 通知）
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.t !== "msg") return;
  inbox.push(open(sessionKey, "d2c", frame.data));
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
let sentFirst = false;
function send(method, params = {}) {
  const id = nextId++;
  const envelope = seal(sessionKey, "c2d", { id, method, params });
  if (!sentFirst) {
    envelope.v = 1;
    envelope.k = exportPublicKeyRaw(clientKeys.publicKey).toString("base64"); // 首帧带客户端公钥
    sentFirst = true;
  }
  ws.send(JSON.stringify({ t: "msg", data: envelope }));
  return id;
}
async function waitMsg(pred, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() - t0 > ms) throw new Error("等待消息超时");
    await sleep(25);
  }
}
const reply = (id, ms) => waitMsg((m) => m.id === id, ms);
const notify = (method, pred = () => true, ms) => waitMsg((m) => m.method === method && pred(m.params ?? {}), ms);

async function main() {
  // —— 鉴权与能力 ——
  const auth = await reply(send("auth", { pairToken, name: "e2e手机" }));
  const deviceId = auth.result?.deviceId;
  if (!deviceId) throw new Error(`配对失败: ${JSON.stringify(auth)}`);
  if (auth.result.caps?.terminal === 1) ok("auth 应答声明 caps.terminal（开关已开 + host 可用）");
  else fail("caps.terminal", JSON.stringify(auth.result.caps));

  // —— 权限链：设备默认无 terminalAccess → 403 ——
  const denied = await reply(send("terminal.presets"));
  if (denied.error?.code === 403) ok("默认无 terminalAccess：terminal.* 一律 403");
  else fail("默认拒绝", JSON.stringify(denied));

  // 电脑端授权（写配置文件，config-watch 热核对）
  const fresh = loadOrCreateConfig(configPath);
  fresh.devices.find((d) => d.deviceId === deviceId).terminalAccess = true;
  saveConfig(configPath, fresh);
  let presets = null;
  for (let i = 0; i < 40 && !presets; i++) {
    await sleep(150);
    const r = await reply(send("terminal.presets"));
    if (r.result) presets = r.result;
  }
  if (presets?.presets?.some((p) => p.id === "shell")) ok("授权热生效：presets 返回（含 Shell）");
  else { fail("授权热生效", JSON.stringify(presets)); throw new Error("无法继续"); }

  // —— 创建 + attach + 快照 ——
  const created = await reply(send("terminal.create", { presetId: "shell", cwd: dir, cols: 80, rows: 24 }));
  const tid = created.result?.terminalId;
  if (created.result?.status === "RUNNING" && created.result.ownerDeviceId === deviceId) {
    ok(`terminal.create：RUNNING，owner=本机（${created.result.title}）`);
  } else {
    fail("terminal.create", JSON.stringify(created));
    throw new Error("无法继续");
  }
  const attachId = send("terminal.attach", { terminalId: tid, cols: 80, rows: 24 });
  const att = await reply(attachId);
  if (att.result?.mode === "snapshot" && att.result.generation) ok("terminal.attach：snapshot 模式 + generation");
  else fail("terminal.attach", JSON.stringify(att));
  const snap = await notify("terminal.snapshot", (p) => p.terminalId === tid && p.final === true);
  ok(`terminal.snapshot 帧送达（part=${snap.params.part}, nextSeq=${snap.params.nextSeq}）`);

  // —— 指令输入（bracketed 判定在 daemon）→ 输出帧 ——
  await reply(send("terminal.input", { terminalId: tid, text: "echo E2E-$((3*3))-OK", submit: true }));
  let outText = "";
  const t0 = Date.now();
  while (!outText.includes("E2E-9-OK") && Date.now() - t0 < 10000) {
    const m = await notify("terminal.output", (p) => p.terminalId === tid);
    outText += Buffer.from(m.params.data, "base64").toString("utf8");
  }
  if (outText.includes("E2E-9-OK")) ok("terminal.input → terminal.output 帧往返（E2E 信封全链路）");
  else fail("输出往返", JSON.stringify(outText.slice(-120)));

  // —— 列表与活跃时间戳 ——
  const list = await reply(send("terminal.list"));
  const item = list.result?.terminals?.find((x) => x.terminalId === tid);
  if (item?.status === "RUNNING" && item.lastOutputAt > 0) ok("terminal.list：状态与 lastOutputAt");
  else fail("terminal.list", JSON.stringify(item));

  // —— 非法信号被拒 ——
  const badSig = await reply(send("terminal.signal", { terminalId: tid, kind: "kill" }));
  if (badSig.error?.code === 400) ok("terminal.signal 白名单：kill 被拒");
  else fail("signal 白名单", JSON.stringify(badSig));

  // —— close → exited 帧（HIGH 直发）——
  await reply(send("terminal.close", { terminalId: tid }));
  const exited = await notify("terminal.exited", (p) => p.terminalId === tid);
  ok(`terminal.close → terminal.exited 帧（signal=${exited.params.exitSignal ?? exited.params.exitCode}）`);

  // 已退出终端 close = 移除
  const rm = await reply(send("terminal.close", { terminalId: tid }));
  if (rm.result?.removed === true) ok("再次 close：从列表移除并回收目录");
  else fail("移除", JSON.stringify(rm));

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

try {
  await main();
} catch (err) {
  console.error(`\nFAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  daemon.stop();
  relay.close();
  await sleep(300);
  for (const s of listPtyHosts(join(dirname(configPath), "pty"))) {
    try { process.kill(s.hostPid, "SIGKILL"); } catch {}
    try { process.kill(s.childPid, "SIGKILL"); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
