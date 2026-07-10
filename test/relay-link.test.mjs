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

test("duplicate-daemon close stops relay reconnecting", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets.length, 1, "duplicate daemon close must not schedule a reconnect");
    assert.match(logs.at(-1), /停止本实例的 relay 重连/);
  } finally {
    globalThis.WebSocket = original;
  }
});
