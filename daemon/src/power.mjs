// 跨平台防睡眠：持有一个"保持清醒"子进程，kill 即释放。
// 阻止系统睡眠但允许关屏（远程场景人不在电脑前，屏幕该关，但电脑不能睡，
// 否则 daemon 离线、正在跑的任务中断）。
import { spawn as realSpawn } from "node:child_process";

// Windows：SetThreadExecutionState 是线程级状态，进程退出即自动清除，
// 无需显式还原。ES_CONTINUOUS(0x80000000)|ES_SYSTEM_REQUIRED(0x00000001)=0x80000001。
const WIN_SCRIPT = [
  "$s=Add-Type -MemberDefinition",
  "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);'",
  "-Name Pwr -Namespace Czr -PassThru;",
  "while($true){ [void]$s::SetThreadExecutionState(0x80000001); Start-Sleep -Seconds 50 }",
].join(" ");

export class PowerManager {
  #platform;
  #spawn;
  #log;
  #proc = null;
  #warned = false;

  constructor({ platform = process.platform, spawn = realSpawn, log = () => {} } = {}) {
    this.#platform = platform;
    this.#spawn = spawn;
    this.#log = log;
  }

  get active() {
    return this.#proc !== null;
  }

  // 平台对应的"保持清醒"命令；不支持的平台返回 null
  inhibitorCommand() {
    switch (this.#platform) {
      case "win32":
        return ["powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT]];
      case "darwin":
        // -i 阻止 idle sleep；不加 -d，允许显示器休眠
        return ["caffeinate", ["-i"]];
      case "linux":
        return [
          "systemd-inhibit",
          ["--what=sleep", "--who=CXX Remote", "--why=daemon active", "--mode=block", "sleep", "infinity"],
        ];
      default:
        return null;
    }
  }

  acquire() {
    if (this.#proc) return;
    const cmd = this.inhibitorCommand();
    if (!cmd) {
      if (!this.#warned) {
        this.#warned = true;
        this.#log(`当前平台(${this.#platform})不支持防睡眠，跳过`);
      }
      return;
    }
    try {
      this.#proc = this.#spawn(cmd[0], cmd[1], { stdio: "ignore" });
      this.#proc.on("exit", () => {
        // 意外退出（如命令不存在）：清空引用，下次 acquire 会重试
        this.#proc = null;
      });
      this.#proc.on("error", (err) => {
        this.#log(`防睡眠进程启动失败: ${err.message}`);
        this.#proc = null;
      });
      this.#log("已阻止系统睡眠（允许关屏）");
    } catch (err) {
      this.#log(`防睡眠不可用: ${err.message}`);
      this.#proc = null;
    }
  }

  release() {
    if (!this.#proc) return;
    try {
      this.#proc.kill();
    } catch {
      // 已退出
    }
    this.#proc = null;
    this.#log("已恢复系统睡眠策略");
  }
}
