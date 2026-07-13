import assert from "node:assert/strict";
import test from "node:test";

import { RelayLink, daemonRelayUrl } from "../daemon/src/relay-link.mjs";

test("daemon relay URL includes platform metadata", () => {
  assert.equal(
    daemonRelayUrl("wss://relay.wokey.ai/", "abc123", { platform: "darwin" }),
    "wss://relay.wokey.ai/v1/daemon/abc123?os=darwin&app=cxx",
  );
});

test("daemon relay URL encodes metadata", () => {
  assert.equal(
    daemonRelayUrl("wss://relay.example.test", "abc123", { platform: "win 32", app: "c x x" }),
    "wss://relay.example.test/v1/daemon/abc123?os=win+32&app=c+x+x",
  );
});

test("duplicate-daemon (1008) close keeps reconnecting instead of standing down", async () => {
  // 单实例锁保证本机只有一个 daemon，故 1008“同 daemonId 已在线”只可能是自身旧连接的
  // 服务端 socket 残留造成的假阳性。它绝不能让 daemon 永久停摆，必须照常退避重连。
  const original = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }
    close(code, reason) {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const logs = [];
    const relay = new RelayLink("wss://relay.example.test", "abc123", {
      log: (message) => logs.push(message),
    });
    relay.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    sockets[0].onclose?.({ code: 1008, reason: "daemon already connected" });
    assert.ok(
      logs.some((line) => /继续重连/.test(line)),
      "1008 应记录为可恢复而非永久停摆",
    );
    // 首次断开退避 = BACKOFF_BASE_MS(1000ms)；等它过去后应已建立第二条连接。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(sockets.length, 2, "duplicate daemon close must schedule a reconnect");
  } finally {
    globalThis.WebSocket = original;
  }
});
