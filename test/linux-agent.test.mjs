import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UNIT_NAME,
  buildExecStart,
  buildUnitFile,
  quoteSystemdArg,
  systemdPath,
  makeDeps,
  isEnabled,
  isRunning,
  enable,
  disable,
  unitPath,
} from "../daemon/src/linux-agent.mjs";

function harness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cxx-linux-agent-"));
  const unitDir = join(dir, "systemd", "user");
  const calls = [];
  const state = {
    active: false,
    enabledLink: false,
    hasSystemctl: true,
    linger: false,
    failEnable: false,
    failReload: false,
    failRestart: false,
  };
  const deps = makeDeps({
    configPath: join(dir, "daemon.json"),
    homeDir: dir,
    unitDir,
    platform: "linux",
    user: "tester",
    hasSystemctl: () => state.hasSystemctl,
    readLinger: () => state.linger,
    runSystemctl: (args) => {
      calls.push([...args]);
      const cmd = args[0];
      if (cmd === "daemon-reload") {
        return { status: state.failReload ? 1 : 0, stdout: "", stderr: state.failReload ? "reload fail" : "" };
      }
      if (cmd === "enable") {
        if (state.failEnable) return { status: 1, stdout: "", stderr: "enable fail" };
        state.enabledLink = true;
        state.active = args.includes("--now");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "restart") {
        if (state.failRestart) return { status: 1, stdout: "", stderr: "restart fail" };
        state.active = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "disable") {
        state.enabledLink = false;
        if (args.includes("--now")) state.active = false;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "is-active") {
        return { status: state.active ? 0 : 1, stdout: state.active ? "active\n" : "inactive\n", stderr: "" };
      }
      if (cmd === "is-enabled") {
        return {
          status: state.enabledLink ? 0 : 1,
          stdout: state.enabledLink ? "enabled\n" : "disabled\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  });
  return { dir, deps, calls, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("quoteSystemdArg only quotes when needed", () => {
  assert.equal(quoteSystemdArg("/usr/bin/cxx"), "/usr/bin/cxx");
  assert.equal(quoteSystemdArg("/path with spaces/cxx"), '"/path with spaces/cxx"');
  assert.equal(quoteSystemdArg('say "hi"'), '"say \\"hi\\""');
});

test("buildExecStart joins program arguments", () => {
  assert.equal(
    buildExecStart(["/opt/cxx", "start", "--config", "/home/a b/daemon.json"]),
    '/opt/cxx start --config "/home/a b/daemon.json"',
  );
});

test("buildUnitFile writes Restart, PATH, and log append", () => {
  const body = buildUnitFile({
    programArguments: ["/home/u/.local/bin/cxx", "start"],
    logPath: "/home/u/.cxx/remote/daemon.log",
    pathEnv: "/home/u/.local/bin:/usr/bin",
  });
  assert.match(body, /\[Service\]/);
  assert.match(body, /ExecStart=\/home\/u\/\.local\/bin\/cxx start/);
  assert.match(body, /Restart=always/);
  assert.match(body, /Environment=PATH=\/home\/u\/\.local\/bin:\/usr\/bin/);
  assert.match(body, /StandardOutput=append:\/home\/u\/\.cxx\/remote\/daemon\.log/);
  assert.match(body, /StandardError=append:\/home\/u\/\.cxx\/remote\/daemon\.log/);
  assert.match(body, /WantedBy=default\.target/);
  assert.match(body, /Description=CXX remote daemon/);
});

test("systemdPath prefers user local bins", () => {
  const p = systemdPath("/home/alice");
  assert.ok(p.startsWith("/home/alice/.local/bin:"));
  assert.ok(p.includes("/usr/bin"));
});

test("enable writes unit, reloads, enable --now, then restart; linger false adds hint", () => {
  const h = harness();
  try {
    const res = enable(h.deps);
    assert.equal(res.ok, true);
    assert.equal(res.enabled, true);
    assert.equal(res.linger, false);
    assert.match(res.hint, /loginctl enable-linger tester/);
    assert.equal(existsSync(unitPath(h.deps)), true);
    const body = readFileSync(unitPath(h.deps), "utf8");
    assert.match(body, /ExecStart=/);
    assert.match(body, /start/);
    assert.deepEqual(
      h.calls.map((c) => c[0]),
      ["daemon-reload", "enable", "restart"],
    );
    assert.ok(h.calls[1].includes("--now"));
    assert.ok(h.calls[1].includes(UNIT_NAME));
    assert.ok(h.calls[2].includes(UNIT_NAME));
    assert.equal(h.state.active, true);
  } finally {
    h.cleanup();
  }
});

test("enable restarts even when unit was already active (upgrade path)", () => {
  const h = harness();
  try {
    // Simulate prior install: unit file present, service already running.
    mkdirSync(h.deps.unitDir, { recursive: true });
    writeFileSync(unitPath(h.deps), "[Unit]\nDescription=old\n");
    h.state.active = true;
    h.state.enabledLink = true;
    const res = enable(h.deps);
    assert.equal(res.ok, true);
    assert.ok(h.calls.some((c) => c[0] === "restart"));
    assert.equal(h.calls.filter((c) => c[0] === "restart").length, 1);
  } finally {
    h.cleanup();
  }
});

test("enable rolls back on first-time restart failure; keeps unit on upgrade restart failure", () => {
  const h = harness();
  try {
    h.state.failRestart = true;
    const first = enable(h.deps);
    assert.equal(first.ok, false);
    assert.equal(first.enabled, false);
    assert.match(first.error, /restart fail/);
    assert.equal(existsSync(unitPath(h.deps)), false);

    // Upgrade: unit already on disk before enable rewrites it.
    mkdirSync(h.deps.unitDir, { recursive: true });
    writeFileSync(unitPath(h.deps), "[Unit]\nDescription=old\n");
    h.calls.length = 0;
    const upgrade = enable(h.deps);
    assert.equal(upgrade.ok, false);
    assert.equal(upgrade.enabled, true);
    assert.match(upgrade.error, /restart fail/);
    assert.equal(existsSync(unitPath(h.deps)), true);
  } finally {
    h.cleanup();
  }
});

test("enable with linger yes omits hint", () => {
  const h = harness();
  h.state.linger = true;
  try {
    const res = enable(h.deps);
    assert.equal(res.ok, true);
    assert.equal(res.linger, true);
    assert.equal(res.hint, undefined);
  } finally {
    h.cleanup();
  }
});

test("enable rolls back unit when enable --now fails", () => {
  const h = harness();
  h.state.failEnable = true;
  try {
    const res = enable(h.deps);
    assert.equal(res.ok, false);
    assert.equal(res.enabled, false);
    assert.match(res.error, /enable fail/);
    assert.equal(existsSync(unitPath(h.deps)), false);
  } finally {
    h.cleanup();
  }
});

test("enable fails clearly without systemctl", () => {
  const h = harness();
  h.state.hasSystemctl = false;
  try {
    const res = enable(h.deps);
    assert.equal(res.ok, false);
    assert.match(res.error, /systemctl/);
    assert.equal(existsSync(unitPath(h.deps)), false);
  } finally {
    h.cleanup();
  }
});

test("disable stops unit and removes file", () => {
  const h = harness();
  try {
    enable(h.deps);
    assert.equal(isEnabled(h.deps), true);
    h.state.active = true;
    assert.equal(isRunning(h.deps), true);
    const res = disable(h.deps);
    assert.equal(res.enabled, false);
    assert.equal(existsSync(unitPath(h.deps)), false);
    assert.equal(isEnabled(h.deps), false);
    assert.ok(h.calls.some((c) => c[0] === "disable" && c.includes("--now")));
  } finally {
    h.cleanup();
  }
});

test("isEnabled is true when unit file exists even if is-enabled says no", () => {
  const h = harness();
  try {
    mkdirSync(h.deps.unitDir, { recursive: true });
    writeFileSync(unitPath(h.deps), "[Unit]\nDescription=test\n");
    h.state.enabledLink = false;
    assert.equal(isEnabled(h.deps), true);
  } finally {
    h.cleanup();
  }
});
