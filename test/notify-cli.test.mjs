import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = join(root, "daemon", "src", "main.mjs");

function runNotify(configPath, args) {
  return spawnSync(
    process.execPath,
    [main, "notify", "--config", configPath, ...args],
    { cwd: root, encoding: "utf8" },
  );
}

test("CLI 添加 OneBot 11 私聊渠道并保存目标和令牌", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  const configPath = join(dir, "daemon.json");
  try {
    const result = runNotify(configPath, [
      "--add",
      "onebot11",
      "--url",
      "http://127.0.0.1:4531/send_msg",
      "--target",
      "private:3102048152",
      "--token",
      "test-token",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const notifier = JSON.parse(readFileSync(configPath, "utf8")).notifiers[0];
    assert.deepEqual(notifier, {
      type: "onebot11",
      url: "http://127.0.0.1:4531/send_msg",
      targetType: "private",
      targetId: "3102048152",
      token: "test-token",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 拒绝非法 OneBot 目标", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  const configPath = join(dir, "daemon.json");
  try {
    const result = runNotify(configPath, [
      "--add",
      "onebot11",
      "--url",
      "http://127.0.0.1:4531/send_msg",
      "--target",
      "3102048152",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--target/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).notifiers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 拒绝非 HTTP(S) 的 OneBot 地址", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  const configPath = join(dir, "daemon.json");
  try {
    const result = runNotify(configPath, [
      "--add",
      "onebot11",
      "--url",
      "ftp://127.0.0.1:4531/send_msg",
      "--target",
      "private:3102048152",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /http/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).notifiers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
