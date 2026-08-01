import assert from "node:assert/strict";
import test from "node:test";

import { Notifier, buildRequest, parseOneBotTarget } from "../daemon/src/notify.mjs";

test("解析 OneBot 11 私聊和群聊目标", () => {
  assert.deepEqual(parseOneBotTarget("private:3102048152"), {
    targetType: "private",
    targetId: "3102048152",
  });
  assert.deepEqual(parseOneBotTarget("group:123456"), {
    targetType: "group",
    targetId: "123456",
  });
});

test("拒绝缺少类型、非数字或非正数的 OneBot 目标", () => {
  assert.equal(parseOneBotTarget("3102048152"), null);
  assert.equal(parseOneBotTarget("private:abc"), null);
  assert.equal(parseOneBotTarget("group:0"), null);
  assert.equal(parseOneBotTarget("group:"), null);
});

test("构造 OneBot 11 私聊纯文本请求并保留 CXX 消息内容", () => {
  const request = buildRequest(
    {
      type: "onebot11",
      url: "http://127.0.0.1:4531/send_msg",
      targetType: "private",
      targetId: "3102048152",
      token: "secret-token",
    },
    "任务完成",
    "正文内容",
    "https://example.com/session",
  );

  assert.equal(request.url, "http://127.0.0.1:4531/send_msg");
  assert.deepEqual(JSON.parse(request.init.body), {
    message_type: "private",
    user_id: "3102048152",
    message: "任务完成\n正文内容\nhttps://example.com/session",
    auto_escape: true,
  });
  assert.equal(request.init.headers.authorization, "Bearer secret-token");
});

test("构造 OneBot 11 群聊请求", () => {
  const request = buildRequest(
    { type: "onebot11", url: "http://127.0.0.1:4531/send_msg", targetType: "group", targetId: "123456" },
    "标题",
    "正文",
  );

  assert.deepEqual(JSON.parse(request.init.body), {
    message_type: "group",
    group_id: "123456",
    message: "标题\n正文",
    auto_escape: true,
  });
  assert.equal(request.init.headers.authorization, undefined);
});

test("OneBot 11 业务失败响应会记录失败日志", async () => {
  const logs = [];
  const notifier = new Notifier(
    [{ type: "onebot11", url: "http://127.0.0.1:4531/send_msg", targetType: "private", targetId: "1" }],
    {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: "failed", retcode: 100 }) }),
      log: (message) => logs.push(message),
    },
  );

  await notifier.send("标题", "正文");

  assert.equal(logs.length, 1);
  assert.match(logs[0], /HTTP 200/);
  assert.match(logs[0], /status failed/);
  assert.match(logs[0], /retcode 100/);
});
