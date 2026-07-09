// 子进程崩溃残留的落盘与收割（codex app-server 与 claude 常驻舰队共用）。
//
// daemon 被 SIGKILL/崩溃时来不及走 stop()，子进程会变孤儿。策略：运行期把子进程
// pid 落盘（writePidFile），下次启动先收割（reapStalePids）。两个防误杀原则：
//   1. 认主：pidfile 记录属主 daemon 的 pid，属主仍存活说明那是并行实例（LaunchAgent
//      之外又跑了个 dev 实例）的活舰队，整体跳过、也不动人家的 pidfile。
//   2. 验身：pid 可能已被系统回收给无关进程，杀之前核对命令行；查不到命令行就不杀
//      ——误杀被回收的 pid 比漏掉残留代价高得多。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 杀掉整棵进程树。codex/claude 都是「node wrapper → 原生/工具子进程」多级结构，只 kill
// wrapper 信号不转发，子进程会变孤儿泄漏（历史上攒到几十个占端口/内存）。
// 故 spawn 时 detached 令其自成进程组，这里用负 pid 一次带走组内全部。
export function killProcessTree(pid, log = () => {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    // Windows 无 POSIX 进程组语义：taskkill /t 递归杀子树
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    } catch (err) {
      log(`taskkill 失败 pid=${pid}: ${err?.message ?? err}`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM"); // 负 pid = 整个进程组
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {} // 组不存在则退回单进程
  }
  // 宽限后强杀兜底：wrapper/原生任一忽略 SIGTERM 也确保退出
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }, 2000).unref?.();
}

// EPERM = 进程存在但无权限发信号，也算存活。
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// 确认 pid 的命令行仍匹配我们拉起的子进程，而非被系统回收给别的进程。
// 两个平台都是「查不到/不匹配就不杀」。
function pidMatchesCommandLine(pid, cmdlineRe) {
  if (process.platform === "win32") {
    // taskkill 只查存在不查身份，tasklist 不给命令行——用 CIM 核对（pid 已经过整数校验）
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      return cmdlineRe.test(out);
    } catch {
      return false;
    }
  }
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmdlineRe.test(cmd);
  } catch {
    return false; // ps 查不到 = 进程已不在
  }
}

// 落盘当前在跑的子进程 pid（含属主标记）。尽力而为：写不了只损失崩溃清理，不影响功能。
export function writePidFile(pidFile, pids, log = () => {}) {
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({ daemon: process.pid, pids: [...pids] }));
  } catch (err) {
    log(`写 pidfile 失败 ${pidFile}: ${err?.message ?? err}`);
  }
}

// 启动时收割上一条 daemon 生命周期的残留。兼容三代格式：
// {daemon, pids}（现行）/ 纯数组（旧 claude）/ 纯数字文本（旧 codex 的 String(pid)）。
export function reapStalePids(pidFile, cmdlineRe, { log = () => {}, label = "进程" } = {}) {
  let data;
  try {
    data = JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return; // 无 pidfile/不可解析 = 上次干净退出，无需清理
  }
  const owner = Number.isInteger(data?.daemon) ? data.daemon : 0;
  const pids = Array.isArray(data?.pids)
    ? data.pids
    : Array.isArray(data)
      ? data
      : Number.isInteger(data)
        ? [data]
        : [];
  if (owner && owner !== process.pid && isProcessAlive(owner)) {
    log(`跳过${label}残留清理：pidfile 属于仍在运行的 daemon（pid=${owner}）`);
    return; // 不是残留，也别动人家的 pidfile
  }
  for (const pid of pids) {
    if (Number.isInteger(pid) && pid > 0 && pidMatchesCommandLine(pid, cmdlineRe)) {
      log(`清理上次遗留的${label}（pid=${pid}）`);
      killProcessTree(pid, log);
    }
  }
  try {
    rmSync(pidFile);
  } catch {
    // ignore
  }
}
