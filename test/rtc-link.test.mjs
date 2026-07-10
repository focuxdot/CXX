import assert from "node:assert/strict";
import test from "node:test";

import { RtcLink } from "../daemon/src/rtc-link.mjs";
import werift from "../daemon/src/vendor/werift.cjs";

const { RTCPeerConnection } = werift;

// 模拟浏览器端：werift 充当 offer 方（与浏览器同为标准 RTCPeerConnection 语义），
// vanilla ICE——收集完 candidate 再交 offer，与网页端实现一致
async function makeClientOffer() {
  const pc = new RTCPeerConnection({ iceServers: [], maxMessageSize: 256 * 1024 });
  const channel = pc.createDataChannel("cxx");
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const cap = setTimeout(resolve, 1500);
    pc.iceGatheringStateChange.subscribe((s) => {
      if (s === "complete") { clearTimeout(cap); resolve(); }
    });
  });
  return { pc, channel };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("rtc-link: offer/answer 建通道，信封帧双向路由，close 触发回收", async () => {
  const opened = deferred();
  const gotMessage = deferred();
  const closed = deferred();
  let io;
  const link = new RtcLink({
    log: () => {},
    onOpen(cid, connIo) { io = connIo; opened.resolve(cid); },
    onMessage(cid, data) { gotMessage.resolve({ cid, data }); },
    onClose(cid) { closed.resolve(cid); },
  });
  const { pc, channel } = await makeClientOffer();
  try {
    const answer = await link.handleOffer("owner-1", {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    });
    assert.equal(answer.type, "answer");
    assert.ok(answer.sdp.includes("m=application"), "answer 应含 datachannel m-line");
    await pc.setRemoteDescription(answer);

    const clientGot = deferred();
    channel.onMessage.subscribe((raw) => clientGot.resolve(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("datachannel 未在 10s 内打开")), 10_000);
      channel.stateChanged.subscribe((s) => {
        if (s === "open") { clearTimeout(t); resolve(); }
      });
      if (channel.readyState === "open") { clearTimeout(t); resolve(); }
    });

    const cid = await opened.promise;
    assert.match(cid, /^rtc-\d+$/);
    assert.equal(link.peerCount, 1);

    // client -> daemon：JSON 帧原样解析后路由（信封内容 rtc-link 零感知）
    channel.send(JSON.stringify({ v: 1, k: "ephkey", n: "iv", c: "cipher" }));
    const inbound = await gotMessage.promise;
    assert.equal(inbound.cid, cid);
    assert.equal(inbound.data.k, "ephkey");

    // daemon -> client：io.send 序列化发回
    io.send({ n: "iv2", c: "cipher2" });
    const outbound = await clientGot.promise;
    assert.equal(outbound.c, "cipher2");
    assert.equal(typeof io.bufferedAmount(), "number");

    // 显式关闭：回收 pc 并回调 onClose
    io.close();
    assert.equal(await closed.promise, cid);
    assert.equal(link.peerCount, 0);
  } finally {
    try { pc.close(); } catch {}
    link.stop();
  }
});

test("rtc-link: 非法 offer 拒绝，不留半成品 peer", async () => {
  const link = new RtcLink({ log: () => {}, onOpen() {}, onMessage() {}, onClose() {} });
  try {
    await assert.rejects(() => link.handleOffer("o", { type: "answer", sdp: "x" }), /参数非法/);
    await assert.rejects(() => link.handleOffer("o", { type: "offer", sdp: "" }), /参数非法/);
    await assert.rejects(() => link.handleOffer("o", null), /参数非法/);
    await assert.rejects(
      () => link.handleOffer("o", { type: "offer", sdp: "x".repeat(64_001) }),
      /参数非法/,
    );
    // 注：语法上可解析但无意义的 SDP（如空 "v=0"）werift 会宽容地协商出 answer，
    // 由 OPEN_TIMEOUT（通道永远开不了）兜底回收；真正的挂起路径由协商总限时兜底
    assert.equal(link.peerCount, 0);
  } finally {
    link.stop();
  }
});

test("rtc-link: stop 后拒绝新协商", async () => {
  const link = new RtcLink({ log: () => {}, onOpen() {}, onMessage() {}, onClose() {} });
  link.stop();
  await assert.rejects(() => link.handleOffer("o", { type: "offer", sdp: "v=0\n" }), /已停用/);
});
