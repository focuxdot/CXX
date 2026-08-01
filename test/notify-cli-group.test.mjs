import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = join(root, "daemon", "src", "main.mjs");

test("CLI 添加 OneBot 11 群聊渠道", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  const configPath = join(dir, "daemon.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        main,
        "notify",
        "--config",
        configPath,
        "--add",
        "onebot11",
        "--url",
        "http://127.0.0.1:4531/send_msg",
        "--target",
        "group:123456",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).notifiers[0], {
      type: "onebot11",
      url: "http://127.0.0.1:4531/send_msg",
      targetType: "group",
      targetId: "123456",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
