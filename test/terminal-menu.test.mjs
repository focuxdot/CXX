// menu-backend 的 Terminal Mode 命令面（§4.8/§13.1）：开关、逐设备授权、状态读取。
// terminal-close 的真实 socket 路径由 scripts/smoke-terminal.mjs 家族覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import {
  terminalStatus,
  terminalEnable,
  terminalAccess,
  terminalClose,
  runMenuCommand,
  MENU_COMMANDS,
} from "../daemon/src/menu-backend.mjs";

function makeDeps() {
  const dir = mkdtempSync(join(tmpdir(), "cxx-term-menu-"));
  const configPath = join(dir, "daemon.json");
  const config = loadOrCreateConfig(configPath);
  config.devices = [
    { deviceId: "devA", name: "iPhone", tokenHash: "x", createdAt: 1 },
    { deviceId: "devV", name: "围观", tokenHash: "y", role: "viewer" },
  ];
  saveConfig(configPath, config);
  return { deps: { configPath, isRunning: () => false, log: () => {} }, dir, configPath };
}

test("terminal-enable / terminal-access：写配置且默认关", () => {
  const { deps, dir, configPath } = makeDeps();
  const st0 = terminalStatus(deps);
  assert.equal(st0.enabled, false); // 升级后的存量配置默认 false
  assert.equal(st0.devices.length, 1); // viewer 不出现在授权列表
  assert.equal(st0.devices[0].terminalAccess, false);

  assert.equal(terminalEnable(deps, true).enabled, true);
  assert.equal(loadOrCreateConfig(configPath).terminalEnabled, true);
  assert.equal(terminalEnable(deps, false).enabled, false);

  const r = terminalAccess(deps, "devA", true);
  assert.equal(r.ok, true);
  assert.equal(loadOrCreateConfig(configPath).devices[0].terminalAccess, true);
  // viewer 不可授权；未知设备报错
  assert.equal(terminalAccess(deps, "devV", true).ok, false);
  assert.equal(terminalAccess(deps, "nope", true).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("terminal-status：无注册目录时终端列表为空", () => {
  const { deps, dir } = makeDeps();
  const st = terminalStatus(deps);
  assert.deepEqual(st.terminals, []);
  assert.equal(typeof st.hostAvailable, "boolean");
  rmSync(dir, { recursive: true, force: true });
});

test("terminal-close：非法 id / 不存在的终端", async () => {
  const { deps, dir } = makeDeps();
  assert.equal((await terminalClose(deps, "../escape")).ok, false); // 路径穿越形状直接拒
  assert.equal((await terminalClose(deps, "t-nope")).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("runMenuCommand 分发与 MENU_COMMANDS 注册", async () => {
  const { deps, dir } = makeDeps();
  for (const cmd of ["terminal-status", "terminal-enable", "terminal-access", "terminal-close"]) {
    assert.ok(MENU_COMMANDS.has(cmd), cmd);
  }
  const r = await runMenuCommand("terminal-enable", ["1"], deps);
  assert.equal(r.enabled, true);
  const r2 = await runMenuCommand("terminal-enable", ["0"], deps);
  assert.equal(r2.enabled, false);
  rmSync(dir, { recursive: true, force: true });
});
