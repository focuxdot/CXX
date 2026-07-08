import assert from "node:assert/strict";
import test from "node:test";

import { codexInvocation, resolveCodexCommand } from "../daemon/src/codex-path.mjs";

function existsSet(paths) {
  const set = new Set(paths);
  return (path) => set.has(path);
}

test("Windows resolver finds the npm codex.cmd shim", () => {
  const home = "C:\\Users\\Ada";
  const appdata = `${home}\\AppData\\Roaming`;
  const shim = `${appdata}\\npm\\codex.cmd`;
  const resolved = resolveCodexCommand("codex", {
    platform: "win32",
    homeDir: home,
    env: {
      APPDATA: appdata,
      LOCALAPPDATA: `${home}\\AppData\\Local`,
      ProgramFiles: "C:\\Program Files",
      Path: "",
    },
    exists: existsSet([shim]),
  });
  assert.equal(resolved, shim);
});

test("Windows resolver prefers executable siblings over an explicit codex.ps1", () => {
  const ps1 = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.ps1";
  const cmd = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd";
  const resolved = resolveCodexCommand(ps1, {
    platform: "win32",
    env: {},
    exists: existsSet([ps1, cmd]),
  });
  assert.equal(resolved, cmd);
});

test("Windows resolver searches PATH without selecting PowerShell-only shims", () => {
  const dir = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
  const cmd = `${dir}\\codex.cmd`;
  const ps1 = `${dir}\\codex.ps1`;
  const resolved = resolveCodexCommand("codex", {
    platform: "win32",
    env: { Path: dir },
    exists: existsSet([ps1, cmd]),
  });
  assert.equal(resolved, cmd);
});

test("Windows invocation runs command shims through the platform shell", () => {
  const cmd = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd";
  const cmdInvocation = codexInvocation(cmd, ["app-server", "--listen", "ws://127.0.0.1:19271"], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(cmdInvocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(cmdInvocation.args, [
    "/d",
    "/s",
    "/c",
    cmd,
    "app-server",
    "--listen",
    "ws://127.0.0.1:19271",
  ]);

  const ps1 = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.ps1";
  const ps1Invocation = codexInvocation(ps1, ["--version"], { platform: "win32" });
  assert.equal(ps1Invocation.command, "powershell.exe");
  assert.deepEqual(ps1Invocation.args, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ps1,
    "--version",
  ]);
});
