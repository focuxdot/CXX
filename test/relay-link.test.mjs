import assert from "node:assert/strict";
import test from "node:test";

import {
  RelayLink,
  daemonRelayUrl,
  ownerConflictRetryDelay,
  reconnectDelay,
  reconnectStormCooldown,
} from "../daemon/src/relay-link.mjs";
import { BaseRelayRoom, daemonConnectionDecision } from "../relay/worker/src/relay-core.mjs";

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

test("daemon relay URL carries version and boot instance metadata", () => {
  assert.equal(
    daemonRelayUrl("wss://relay.example.test", "abc123", {
      platform: "win32",
      app: "cxx",
      version: "0.1.8 beta",
      instanceId: "boot_12345678",
    }),
    "wss://relay.example.test/v1/daemon/abc123?os=win32&app=cxx&ver=0.1.8+beta&inst=boot_12345678",
  );
});

test("reconnect backoff uses jitter, caps at 60s, and storms cool down for 2-5min", () => {
  assert.equal(reconnectDelay(0, () => 1), 1000);
  assert.equal(reconnectDelay(3, () => 0.5), 4000);
  assert.equal(reconnectDelay(99, () => 1), 60000);
  const now = 1_000_000;
  assert.equal(reconnectStormCooldown(Array(9).fill(now), now, () => 1).delay, 0);
  assert.equal(reconnectStormCooldown(Array(10).fill(now), now, () => 0).delay, 120000);
  assert.equal(reconnectStormCooldown(Array(10).fill(now), now, () => 1).delay, 300000);
  assert.equal(ownerConflictRetryDelay(() => 0), 120000);
  assert.equal(ownerConflictRetryDelay(() => 1), 300000);
});

test("relay owner decision replaces same/stale instance and rejects a different healthy instance", () => {
  const now = 1_000_000;
  assert.equal(daemonConnectionDecision({
    incomingInstanceId: "same_boot",
    existingInstanceId: "same_boot",
    lastHeartbeatAt: now,
    openedAt: now,
    now,
  }), "replace");
  assert.equal(daemonConnectionDecision({
    incomingInstanceId: "new_boot_1",
    existingInstanceId: "old_boot_1",
    lastHeartbeatAt: now - 20_000,
    openedAt: now - 60_000,
    now,
  }), "reject");
  assert.equal(daemonConnectionDecision({
    incomingInstanceId: "new_boot_1",
    existingInstanceId: "old_boot_1",
    lastHeartbeatAt: now - 61_000,
    openedAt: now - 120_000,
    now,
  }), "replace");
  assert.equal(daemonConnectionDecision({
    incomingInstanceId: "new_boot_1",
    existingInstanceId: "",
    openedAt: now - 10_000,
    now,
  }), "reject", "legacy connection gets a first-heartbeat grace window");
});

test("duplicate-daemon (1008) uses a dedicated low-frequency takeover probe", async () => {
  // 1008 表示现有 owner 仍健康：后来者保留接管能力，但不能继续秒级打 Worker。
  const original = globalThis.WebSocket;
  const sockets = [];
  let relay;
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
    relay = new RelayLink("wss://relay.example.test", "abc123", {
      log: (message) => logs.push(message),
    }, { instanceId: "test_boot_123", random: () => 1 });
    relay.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    sockets[0].onclose?.({ code: 1008, reason: "daemon already connected" });
    assert.ok(
      logs.some((line) => /300s 后低频探测接管/.test(line)),
      "1008 应进入专用 2-5 分钟探测周期",
    );
    // 普通断线首跳会在 1s 后重连；owner 冲突不能沿用这个节奏。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(sockets.length, 1, "healthy-owner conflict must not retry after one second");
  } finally {
    relay?.stop();
    globalThis.WebSocket = original;
  }
});

test("rejected daemon sockets never enter client message or close accounting", async () => {
  const originalPair = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {};
  let clientCloses = 0;
  try {
    const state = {
      setWebSocketAutoResponse() {},
      getTags() { return ["rejected-daemon"]; },
    };
    const room = new BaseRelayRoom(state, {}, {
      hooks: { clientClose() { clientCloses += 1; } },
    });
    const rejected = {};
    room.webSocketMessage(rejected, '{"t":"msg","data":"ignored"}');
    await room.webSocketClose(rejected, 1008, "daemon already connected", true);
    assert.equal(clientCloses, 0);
  } finally {
    globalThis.WebSocketRequestResponsePair = originalPair;
  }
});
