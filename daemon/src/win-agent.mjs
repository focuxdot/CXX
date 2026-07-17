// Windows (Task Scheduler) keepalive layer for the CXX daemon.
//
// Mirrors mac-agent.mjs's Model A contract: the tray shell calls
// `cxx-daemon <subcommand>` for one-shot JSON actions, while the daemon itself is
// owned by the platform keepalive service and survives tray exit.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { defaultConfigPath } from "./config.mjs";

export const TASK_NAME = "CXXRemote";

function escapeXml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function quote(s) {
  return `"${String(s).replaceAll('"', '""')}"`;
}

function normalizePath(p) {
  return String(p || "").replaceAll("/", "\\").toLowerCase();
}

function daemonInvocation(configPath) {
  const exec = process.execPath;
  const base = basename(exec).toLowerCase();
  const isNode = base === "node" || base === "node.exe";
  const program = exec;
  const args = isNode && process.argv[1] ? [process.argv[1], "start"] : ["start"];
  if (configPath && configPath !== defaultConfigPath()) args.push("--config", configPath);
  return {
    program,
    args,
    workingDir: isNode && process.argv[1] ? dirname(resolve(process.argv[1])) : dirname(exec),
  };
}

function resolveDaemonInvocation(deps) {
  return deps.daemonInvocation ? deps.daemonInvocation(deps) : daemonInvocation(deps.configPath);
}

export function buildTaskXml({ program, args = [], workingDir, userId, vbs }) {
  const taskArgs = [vbs, program, workingDir, ...args].map(quote).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CXX remote daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${escapeXml(taskArgs)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function currentUserId(env = process.env, run = spawnSync) {
  // `whoami` writes using the active OEM code page, so decoding its redirected
  // output as UTF-8 corrupts non-ASCII account names. WindowsIdentity gives the
  // canonical account (including domain/AzureAD forms); force its pipe to UTF-8.
  try {
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    ].join("; ");
    const res = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    const user = String(res.stdout || "").trim();
    if (res.status === 0 && user.includes("\\")) return user;
  } catch {
    // Fall through to environment fallback.
  }
  // Environment values come from Windows as Unicode and remain a safe fallback.
  const authority = String(env.USERDOMAIN || env.COMPUTERNAME || ".").trim() || ".";
  const username = String(env.USERNAME || "user").trim() || "user";
  return `${authority}\\${username}`;
}

function defaultRunSchtasks(args) {
  return spawnSync("schtasks", args, { encoding: "utf8" });
}

function defaultListProcesses() {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Where-Object { $_.Name -in @('cxx-daemon.exe','node.exe') } |",
    "Select-Object ProcessId,ExecutablePath,CommandLine |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.status !== 0 || !String(res.stdout || "").trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// deps carries: configPath, homeDir, runSchtasks, listProcesses, log.
export function makeDeps(overrides = {}) {
  const home = overrides.homeDir || homedir();
  const installedVbs = resolve(dirname(process.execPath), "run-hidden.vbs");
  return {
    configPath: overrides.configPath || defaultConfigPath(),
    homeDir: home,
    platform: overrides.platform || platform(),
    userId: overrides.userId || currentUserId(),
    vbsPath: overrides.vbsPath || (existsSync(installedVbs) ? installedVbs : join(process.cwd(), "shell", "windows", "run-hidden.vbs")),
    daemonInvocation: overrides.daemonInvocation,
    runSchtasks: overrides.runSchtasks || defaultRunSchtasks,
    listProcesses: overrides.listProcesses || defaultListProcesses,
    log: overrides.log || (() => {}),
    isEnabled,
    isRunning,
    enable,
    disable,
    ...overrides,
  };
}

export function isEnabled(deps) {
  const res = deps.runSchtasks(["/Query", "/TN", TASK_NAME]);
  return res.status === 0;
}

export function isRunning(deps) {
  const inv = resolveDaemonInvocation(deps);
  const program = normalizePath(inv.program);
  const requiredArgs = inv.args.map((a) => String(a).toLowerCase());
  for (const proc of deps.listProcesses()) {
    const exe = normalizePath(proc.ExecutablePath || proc.executablePath);
    const cmd = String(proc.CommandLine || proc.commandLine || "").toLowerCase();
    const programMatches = exe === program || cmd.includes(program.toLowerCase());
    if (!programMatches) continue;
    if (requiredArgs.every((a) => cmd.includes(a))) return true;
  }
  return false;
}

export function enable(deps) {
  if ((deps.platform || platform()) !== "win32") return { ok: false, enabled: false, error: "仅支持 Windows" };
  const inv = resolveDaemonInvocation(deps);
  if (!existsSync(deps.vbsPath)) {
    return { ok: false, enabled: false, error: `找不到隐藏启动器: ${deps.vbsPath}` };
  }
  mkdirSync(dirname(deps.configPath), { recursive: true });
  const xmlPath = resolve(dirname(deps.configPath), "remote-task.xml");
  const xml = buildTaskXml({
    program: inv.program,
    args: inv.args,
    workingDir: inv.workingDir,
    userId: deps.userId,
    vbs: deps.vbsPath,
  });
  // schtasks /XML expects UTF-16LE with BOM.
  writeFileSync(xmlPath, `\ufeff${xml}`, "utf16le");

  const created = deps.runSchtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  if (created.status !== 0) {
    const msg = String(created.stderr || created.stdout || "schtasks 创建计划任务失败").trim();
    deps.log(`schtasks create: ${msg}`);
    return { ok: false, enabled: false, error: msg };
  }
  deps.runSchtasks(["/Run", "/TN", TASK_NAME]);
  return { ok: true, enabled: true };
}

export function disable(deps) {
  deps.runSchtasks(["/End", "/TN", TASK_NAME]);
  deps.runSchtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
  return { ok: true, enabled: false };
}
