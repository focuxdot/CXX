import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import { pair, pairOnce } from "../daemon/src/menu-backend.mjs";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "cxx-menu-win-"));
  const configPath = join(dir, "daemon.json");
  const config = loadOrCreateConfig(configPath);
  config.relayUrl = "wss://relay.wokey.ai";
  config.webUrl = "https://example.test/CXX/";
  saveConfig(configPath, config);
  return {
    dir,
    deps: {
      configPath,
      platform: "win32",
      isRunning: () => false,
      log: () => {},
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("Windows pair returns URL plus QR BMP path", () => {
  const h = harness();
  try {
    const res = pair(h.deps);
    assert.match(res.url, /#d=/);
    assert.ok(res.qrPath);
    assert.equal(existsSync(res.qrPath), true);
    rmSync(res.qrPath, { force: true });
  } finally {
    h.cleanup();
  }
});

test("Windows pair-once returns URL plus QR BMP path", () => {
  const h = harness();
  try {
    const res = pairOnce(h.deps);
    assert.match(res.url, /#p=/);
    assert.ok(res.qrPath);
    assert.equal(existsSync(res.qrPath), true);
    rmSync(res.qrPath, { force: true });
  } finally {
    h.cleanup();
  }
});
