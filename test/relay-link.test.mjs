import assert from "node:assert/strict";
import test from "node:test";

import {
  RelayLink,
  daemonRelayUrl,
  ownerConflictRetryDelay,
  reconnectDelay,
  reconnectStormCooldown,
} from "../daemon/src/relay-link.mjs";
import {
  BaseRelayRoom,
  daemonConnectionAction,
  daemonConnectionDecision,
} from "../relay/worker/src/relay-core.mjs";

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

test("relay owner action upgrades current conflicts and rejects legacy conflicts before upgrade", () => {
  const now = 1_000_000;
  const healthy = {
    existingInstanceId: "old_boot_1",
    lastHeartbeatAt: now,
    openedAt: now - 30_000,
    now,
  };
  assert.equal(daemonConnectionAction({
    ...healthy,
    incomingInstanceId: "new_boot_1",
  }), "reject-websocket");
  assert.equal(daemonConnectionAction({
    ...healthy,
    incomingInstanceId: "",
  }), "reject-http");
  assert.equal(daemonConnectionAction({
    ...healthy,
    incomingInstanceId: "old_boot_1",
  }), "replace");
  assert.equal(daemonConnectionAction({
    ...healthy,
    incomingInstanceId: "new_boot_1",
    lastHeartbeatAt: now - 61_000,
    openedAt: now - 120_000,
  }), "replace");
});

test("legacy owner conflict returns 409 without constructing or accepting a WebSocket", async () => {
  const originalAutoResponse = globalThis.WebSocketRequestResponsePair;
  const originalPair = globalThis.WebSocketPair;
  let pairConstructions = 0;
  let accepted = 0;
  let rejectedPayload = null;
  globalThis.WebSocketRequestResponsePair = class {};
  globalThis.WebSocketPair = class {
    constructor() {
      pairConstructions += 1;
      throw new Error("legacy conflict must not construct WebSocketPair");
    }
  };
  const existing = {
    readyState: 1,
    deserializeAttachment() {
      return { instanceId: "healthy_boot_1", openedAt: Date.now() - 30_000 };
    },
  };
  try {
    const state = {
      storage: {},
      setWebSocketAutoResponse() {},
      getWebSockets(tag) { return tag === "daemon" ? [existing] : []; },
      getWebSocketAutoResponseTimestamp() { return new Date(); },
      acceptWebSocket() { accepted += 1; },
      waitUntil() {},
    };
    const room = new BaseRelayRoom(state, {}, {
      hooks: {
        daemonRejected(payload) { rejectedPayload = payload; },
      },
    });
    const response = await room.fetch(new Request(
      "https://relay.example.test/v1/daemon/daemon123?app=cxx&ver=0.1.7",
      { headers: { Upgrade: "websocket" } },
    ));
    assert.equal(response.status, 409);
    assert.equal(pairConstructions, 0);
    assert.equal(accepted, 0);
    assert.equal(rejectedPayload?.reason, "legacy_owner_conflict");
    assert.equal(rejectedPayload?.meta.instanceId, "");
  } finally {
    globalThis.WebSocketRequestResponsePair = originalAutoResponse;
    globalThis.WebSocketPair = originalPair;
  }
});

test("owner-conflict reject frame closes locally and uses a low-frequency takeover probe", async () => {
  // Worker 用显式帧表示现有 owner 仍健康：后来者主动关闭并进入低频探测。
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
      this.closeCode = code;
      this.closeReason = reason;
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
    sockets[0].onmessage?.({ data: '{"t":"reject","reason":"owner_conflict"}' });
    assert.equal(sockets[0].closeCode, 1008);
    assert.equal(sockets[0].closeReason, "daemon already connected");
    assert.ok(
      logs.some((line) => /300s 后低频探测接管/.test(line)),
      "owner_conflict 应进入专用 2-5 分钟探测周期",
    );
    // 普通断线首跳会在 1s 后重连；owner 冲突不能沿用这个节奏。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(sockets.length, 1, "healthy-owner conflict must not retry after one second");
  } finally {
    relay?.stop();
    globalThis.WebSocket = original;
  }
});

test("legacy 1008 owner conflict remains compatible with the low-frequency probe", async () => {
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
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const logs = [];
    relay = new RelayLink("wss://relay.example.test", "abc123", {
      log: (message) => logs.push(message),
    }, { instanceId: "test_boot_123", random: () => 0 });
    relay.start();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0].onclose?.({ code: 1008, reason: "daemon already connected" });
    assert.ok(logs.some((line) => /120s 后低频探测接管/.test(line)));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(sockets.length, 1);
  } finally {
    relay?.stop();
    globalThis.WebSocket = original;
  }
});

test("worker owner conflict sends a rejection frame without closing before the 101 response", async () => {
  const originalAutoResponse = globalThis.WebSocketRequestResponsePair;
  const originalPair = globalThis.WebSocketPair;
  const originalResponse = globalThis.Response;
  let accepted = null;
  let sent = null;
  let closeCalls = 0;
  const clientEnd = {};
  const serverEnd = {
    send(raw) { sent = raw; },
    close() { closeCalls += 1; },
  };
  globalThis.WebSocketRequestResponsePair = class {};
  globalThis.WebSocketPair = class {
    constructor() { return { 0: clientEnd, 1: serverEnd }; }
  };
  globalThis.Response = class {
    constructor(_body, init = {}) {
      this.status = init.status ?? 200;
      this.webSocket = init.webSocket;
    }
  };
  const existing = {
    readyState: 1,
    deserializeAttachment() {
      return { instanceId: "healthy_boot_1", openedAt: Date.now() - 30_000 };
    },
  };
  try {
    const state = {
      storage: {},
      setWebSocketAutoResponse() {},
      getWebSockets(tag) { return tag === "daemon" ? [existing] : []; },
      getWebSocketAutoResponseTimestamp() { return new Date(); },
      acceptWebSocket(socket, tags) { accepted = { socket, tags }; },
      waitUntil() {},
    };
    const room = new BaseRelayRoom(state, {});
    const response = await room.fetch(new Request(
      "https://relay.example.test/v1/daemon/daemon123?inst=new_boot_123",
      { headers: { Upgrade: "websocket" } },
    ));
    assert.equal(response.status, 101);
    assert.equal(response.webSocket, clientEnd);
    assert.deepEqual(accepted, { socket: serverEnd, tags: ["rejected-daemon"] });
    assert.deepEqual(JSON.parse(sent), { t: "reject", reason: "owner_conflict" });
    assert.equal(closeCalls, 0, "Worker must not close before returning the 101 response");
  } finally {
    globalThis.WebSocketRequestResponsePair = originalAutoResponse;
    globalThis.WebSocketPair = originalPair;
    globalThis.Response = originalResponse;
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
