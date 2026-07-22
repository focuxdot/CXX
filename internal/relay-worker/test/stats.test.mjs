import assert from "node:assert/strict";
import test from "node:test";

import { createStatsHooks } from "../src/stats.mjs";

test("legacy conflict records its reason without sending an operations notification", async () => {
  const originalFetch = globalThis.fetch;
  const points = [];
  let notifications = 0;
  const env = {
    AE: { writeDataPoint(point) { points.push(point); } },
    TG_BOT_TOKEN: "test-token",
    TG_CHAT_ID: "test-chat",
  };
  globalThis.fetch = async () => {
    notifications += 1;
    return new Response("ok", { status: 200 });
  };
  try {
    const hooks = createStatsHooks({ productLabel: "cxx" });
    const payload = {
      env,
      storage: {
        get() { throw new Error("legacy conflicts must not read notification state"); },
        put() { throw new Error("legacy conflicts must not write notification state"); },
      },
      daemonId: "daemon123",
      reason: "legacy_owner_conflict",
      meta: { app: "cxx", os: "darwin", country: "SG", version: "0.1.7" },
    };
    await hooks.daemonRejected(payload);
    await hooks.daemonRejected(payload);

    assert.equal(points.length, 2, "every conflict remains observable");
    assert.equal(points[0].blobs[7], "legacy_owner_conflict");
    assert.equal(notifications, 0, "legacy conflicts must not notify Telegram");
  } finally {
    globalThis.fetch = originalFetch;
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
