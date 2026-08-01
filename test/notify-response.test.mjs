import assert from "node:assert/strict";
import test from "node:test";

import { Notifier } from "../daemon/src/notify.mjs";

function makeNotifier(response, logs) {
  return new Notifier(
    [{ type: "onebot11", url: "http://127.0.0.1:4531/send_msg", targetType: "private", targetId: "1" }],
    { fetch: async () => response, log: (message) => logs.push(message) },
  );
}

test("OneBot 11 成功响应返回 true", async () => {
  const logs = [];
  const sent = await makeNotifier(
    { ok: true, status: 200, json: async () => ({ status: "ok", retcode: 0 }) },
    logs,
  ).send("标题", "正文");

  assert.equal(sent, true);
  assert.deepEqual(logs, []);
});

test("OneBot 11 非 2xx 响应返回 false", async () => {
  const logs = [];
  const sent = await makeNotifier({ ok: false, status: 403 }, logs).send("标题", "正文");

  assert.equal(sent, false);
  assert.match(logs[0], /HTTP 403/);
});

test("OneBot 11 非 JSON 和业务失败响应都返回 false", async () => {
  const invalidLogs = [];
  const invalid = await makeNotifier(
    { ok: true, status: 200, json: async () => { throw new Error("不是 JSON"); } },
    invalidLogs,
  ).send("标题", "正文");
  assert.equal(invalid, false);
  assert.match(invalidLogs[0], /不是有效的 OneBot 11 JSON/);

  const failedLogs = [];
  const failed = await makeNotifier(
    { ok: true, status: 200, json: async () => ({ status: "failed", retcode: 100 }) },
    failedLogs,
  ).send("标题", "正文");
  assert.equal(failed, false);
  assert.match(failedLogs[0], /retcode 100/);
});
