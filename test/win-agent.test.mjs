import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TASK_NAME,
  buildTaskXml,
  makeDeps,
  isEnabled,
  isRunning,
  enable,
  disable,
} from "../daemon/src/win-agent.mjs";

function harness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cxx-win-agent-"));
  const calls = [];
  const state = { taskExists: false, running: false };
  const vbsPath = join(dir, "run-hidden.vbs");
  writeFileSync(vbsPath, "' test\n");
  const deps = makeDeps({
    configPath: join(dir, "daemon.json"),
    homeDir: dir,
    userId: "TESTPC\\Tester",
    platform: "win32",
    vbsPath,
    daemonInvocation: () => ({
      program: "C:\\Program Files\\CXX\\cxx-daemon.exe",
      args: ["start"],
      workingDir: "C:\\Program Files\\CXX",
    }),
    runSchtasks: (args) => {
      calls.push(args);
      if (args[0] === "/Create") state.taskExists = true;
      if (args[0] === "/Delete") state.taskExists = false;
      if (args[0] === "/Query") return { status: state.taskExists ? 0 : 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    listProcesses: () => state.running
      ? [{
          ExecutablePath: "C:\\Program Files\\CXX\\cxx-daemon.exe",
          CommandLine: "\"C:\\Program Files\\CXX\\cxx-daemon.exe\" start",
        }]
      : [],
    ...overrides,
  });
  return { dir, deps, calls, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("buildTaskXml uses logon trigger, failure restart, no time limit, and hidden wscript action", () => {
  const xml = buildTaskXml({
    program: "C:\\Program Files\\CXX\\cxx-daemon.exe",
    args: ["start", "--config", "C:\\Users\\A B\\.cxx\\remote\\daemon.json"],
    workingDir: "C:\\Program Files\\CXX",
    userId: "PC\\User",
    vbs: "C:\\Program Files\\CXX\\run-hidden.vbs",
  });
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>PC\\User<\/UserId>/);
  assert.match(xml, /<RestartOnFailure>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<Count>999<\/Count>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.match(xml, /"C:\\Program Files\\CXX\\run-hidden\.vbs" "C:\\Program Files\\CXX\\cxx-daemon\.exe" "C:\\Program Files\\CXX" "start"/);
});

test("enable writes UTF-16LE BOM task XML, creates task, then runs it", () => {
  const h = harness();
  try {
    const res = enable(h.deps);
    assert.equal(res.ok, true);
    assert.equal(res.enabled, true);
    const xmlPath = join(h.dir, "remote-task.xml");
    assert.equal(existsSync(xmlPath), true);
    const bytes = readFileSync(xmlPath);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xfe);
    const kinds = h.calls.map((c) => c[0]);
    assert.ok(kinds.includes("/Create"));
    assert.ok(kinds.includes("/Run"));
    assert.ok(kinds.indexOf("/Create") < kinds.indexOf("/Run"));
    const create = h.calls.find((c) => c[0] === "/Create");
    assert.ok(create.includes("/TN"));
    assert.ok(create.includes(TASK_NAME));
    assert.ok(create.includes("/XML"));
    assert.ok(create.includes("/F"));
  } finally {
    h.cleanup();
  }
});

test("disable ends then deletes the scheduled task", () => {
  const h = harness();
  try {
    enable(h.deps);
    const res = disable(h.deps);
    assert.equal(res.enabled, false);
    const kinds = h.calls.map((c) => c[0]);
    assert.ok(kinds.includes("/End"));
    assert.ok(kinds.includes("/Delete"));
    const del = h.calls.find((c) => c[0] === "/Delete");
    assert.ok(del.includes(TASK_NAME));
    assert.ok(del.includes("/F"));
  } finally {
    h.cleanup();
  }
});

test("isEnabled follows task query and isRunning follows current daemon process", () => {
  const h = harness();
  try {
    assert.equal(isEnabled(h.deps), false);
    assert.equal(isRunning(h.deps), false);
    enable(h.deps);
    assert.equal(isEnabled(h.deps), true);
    h.state.running = true;
    assert.equal(isRunning(h.deps), true);
    disable(h.deps);
    assert.equal(isEnabled(h.deps), false);
  } finally {
    h.cleanup();
  }
});
