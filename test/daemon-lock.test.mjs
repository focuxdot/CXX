import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DaemonAlreadyRunningError,
  acquireDaemonLock,
  daemonLockPath,
  releaseDaemonLock,
} from "../daemon/src/daemon-lock.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cxx-daemon-lock-"));
  return {
    configPath: join(dir, "daemon.json"),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("daemon lock rejects a second live instance and releases only its own token", () => {
  const f = fixture();
  try {
    const first = acquireDaemonLock(f.configPath, { pid: 101, alive: (pid) => pid === 101 });
    assert.throws(
      () => acquireDaemonLock(f.configPath, { pid: 202, alive: (pid) => pid === 101 }),
      DaemonAlreadyRunningError,
    );
    releaseDaemonLock(first);
    assert.equal(existsSync(daemonLockPath(f.configPath)), false);
  } finally {
    f.cleanup();
  }
});

test("daemon lock replaces a dead owner and cannot delete a successor lock", () => {
  const f = fixture();
  try {
    const path = daemonLockPath(f.configPath);
    writeFileSync(path, JSON.stringify({ pid: 999, token: "dead" }));
    const lock = acquireDaemonLock(f.configPath, { pid: 101, alive: () => false });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 101);

    writeFileSync(path, JSON.stringify({ pid: 202, token: "successor" }));
    releaseDaemonLock(lock);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "successor");
  } finally {
    f.cleanup();
  }
});
