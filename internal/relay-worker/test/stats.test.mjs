import assert from "node:assert/strict";
import test from "node:test";

import { createStatsHooks } from "../src/stats.mjs";

test("legacy conflict records its reason and persists cooldown before notifying", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalInfo = console.info;
  const writes = [];
  const storage = new Map();
  const storageApi = {
    async get(key) { return storage.get(key); },
    async put(key, value) {
      writes.push({ key, value });
      storage.set(key, value);
    },
  };
  const points = [];
  const notifications = [];
  const env = {
    AE: { writeDataPoint(point) { points.push(point); } },
    TG_BOT_TOKEN: "test-token",
    TG_CHAT_ID: "test-chat",
  };
  Date.now = () => 1_000_000;
  console.info = () => {};
  globalThis.fetch = async (_url, init) => {
    notifications.push(JSON.parse(init.body));
    assert.equal(writes.length, 1, "cooldown must be persisted before Telegram I/O");
    return new Response("ok", { status: 200 });
  };
  try {
    const hooks = createStatsHooks({ productLabel: "cxx" });
    const payload = {
      env,
      storage: storageApi,
      daemonId: "daemon123",
      reason: "legacy_owner_conflict",
      meta: { app: "cxx", os: "darwin", country: "SG", version: "0.1.7" },
    };
    await hooks.daemonRejected(payload);
    await hooks.daemonRejected(payload);

    assert.equal(points.length, 2, "every conflict remains observable");
    assert.equal(points[0].blobs[7], "legacy_owner_conflict");
    assert.deepEqual(writes, [{ key: "legacyConflictNotifiedAt", value: 1_000_000 }]);
    assert.equal(notifications.length, 1, "cooldown suppresses duplicate Telegram alerts");
    assert.match(notifications[0].text, /旧客户端连接冲突/);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    console.info = originalInfo;
  }
});

test("current owner conflict records analytics without legacy notification storage", () => {
  const points = [];
  const hooks = createStatsHooks();
  const result = hooks.daemonRejected({
    env: { AE: { writeDataPoint(point) { points.push(point); } } },
    storage: {
      get() { throw new Error("must not read storage"); },
      put() { throw new Error("must not write storage"); },
    },
    daemonId: "daemon123",
    reason: "owner_conflict",
    meta: { instanceId: "current_boot_1" },
  });
  assert.equal(result, undefined);
  assert.equal(points[0].blobs[7], "owner_conflict");
});

test("synthetic probe daemons record analytics without Telegram notifications", async () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const points = [];
  let notifications = 0;
  const storage = {
    get() { throw new Error("must not read storage for synthetic probes"); },
    put() { throw new Error("must not write storage for synthetic probes"); },
  };
  globalThis.fetch = async () => {
    notifications += 1;
    return new Response("ok", { status: 200 });
  };
  console.info = () => {};
  try {
    const hooks = createStatsHooks({ productLabel: "cxx" });
    const env = {
      AE: { writeDataPoint(point) { points.push(point); } },
      TG_BOT_TOKEN: "test-token",
      TG_CHAT_ID: "test-chat",
    };

    await hooks.daemonOpen({
      env,
      storage,
      daemonId: "verify59353ae271ff",
      clientCount: 0,
      meta: { app: "cxx", country: "CN" },
    });
    await hooks.daemonRejected({
      env,
      storage,
      daemonId: "review9d9718a103d6",
      reason: "legacy_owner_conflict",
      meta: { app: "cxx", country: "SG" },
    });

    assert.equal(points.length, 2, "synthetic probes remain visible in analytics");
    assert.equal(points[0].blobs[0], "daemon_open");
    assert.equal(points[1].blobs[0], "daemon_rejected");
    assert.equal(points[1].blobs[7], "legacy_owner_conflict");
    assert.equal(notifications, 0, "synthetic probes must not notify Telegram");
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
  }
});

test("legacy notification failures are fail-open", async () => {
  const originalFetch = globalThis.fetch;
  const errors = [];
  const originalError = console.error;
  const storage = new Map();
  let notifications = 0;
  globalThis.fetch = async () => {
    notifications += 1;
    return new Response("no", { status: 500 });
  };
  console.error = (line) => errors.push(line);
  try {
    const hooks = createStatsHooks();
    const payload = {
      env: { TG_BOT_TOKEN: "test-token", TG_CHAT_ID: "test-chat" },
      storage: {
        async get(key) { return storage.get(key); },
        async put(key, value) { storage.set(key, value); },
      },
      daemonId: "daemon123",
      reason: "legacy_owner_conflict",
      meta: {},
    };
    await assert.doesNotReject(hooks.daemonRejected(payload));
    await assert.doesNotReject(hooks.daemonRejected(payload));
    assert.equal(notifications, 1, "persisted cooldown suppresses retries after Telegram failure");
    assert.ok(errors.some((line) => /telegram_notify_error/.test(line)));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
