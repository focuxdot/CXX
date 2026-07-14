// 终端 spawn 用的环境采集（internal/TERMINAL-MODE.md §7.2）。
//
// daemon 作为 LaunchAgent / 计划任务运行时继承的 PATH 极简（先例见 codex-path.mjs 顶注），
// 直接把 process.env 传给 PTY 子进程会让用户 shell 里的 Homebrew/nvm/自装 CLI 全部消失，
// preset 检测也全军覆没。这里用登录 shell 一次性执行 `env` 采集完整环境并缓存，
// 在其上显式钉死 TERM 与 UTF-8 locale（TUI 对二者高度敏感），并剥除不应下传给
// 任意子进程的 CXX 内部变量。
import { execFile } from "node:child_process";
import process from "node:process";

// 不下传的内部/敏感变量前缀（Claude 审批 hook 的回调令牌等）
const STRIP_PREFIXES = ["CXX_"];

// env 输出解析。优先 NUL 分隔（`env -0`）：值含换行时按行解析会把续行误当成 KEY=VALUE
// （极端下续行的 `PATH=…` 会静默覆盖真实 PATH，令所有 preset 检测失效）。NUL 分隔无此歧义。
// 回退按行（旧 env 无 -0）：仍尽力，丢弃无 "=" 行、跳过函数体。
function parseEnvOutput(out) {
  const env = {};
  const nul = out.includes("\0");
  for (const rec of out.split(nul ? "\0" : "\n")) {
    if (!rec) continue;
    const eq = rec.indexOf("=");
    if (eq <= 0) continue;
    const key = rec.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key.startsWith("BASH_FUNC_")) continue;
    env[key] = rec.slice(eq + 1);
  }
  return env;
}

function sanitize(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  // TUI 硬性要求：256 色 term + UTF-8 locale（Agent 的框线/宽字符/色彩都吃这两个）
  out.TERM = "xterm-256color";
  if (!/utf-?8/i.test(out.LANG ?? "")) out.LANG = "en_US.UTF-8";
  delete out.LC_ALL; // 别让宿主的 LC_ALL 覆盖上面的 LANG 设定
  return out;
}

let cached = null; // Promise<env> —— 单飞：并发首访只采集一次

// 采集登录 shell 的完整环境（缓存，daemon 生命周期内只跑一次）。
// win32 无 LaunchAgent 极简 PATH 问题（计划任务继承用户注册表环境），直接用 process.env。
// 登录 shell 失败（超时/异常 rc 文件）回落 process.env——终端能开比环境完美更重要。
export function captureShellEnv({ timeoutMs = 8000 } = {}) {
  if (cached) return cached;
  cached = (async () => {
    if (process.platform === "win32") return sanitize(process.env);
    const shell = process.env.SHELL || "/bin/sh";
    try {
      const out = await new Promise((resolve, reject) => {
        // -l 登录 shell（读 profile 拿完整 PATH）；不带 -i：交互模式会触发
        // 提示符初始化（powerlevel10k 之类）拖慢甚至挂起，env 导出不需要它。
        // env -0（NUL 分隔）优先，规避含换行的值破坏解析；旧系统无 -0 时回退纯 env。
        execFile(shell, ["-lc", "env -0 2>/dev/null || env"], {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const env = parseEnvOutput(out);
      // PATH 都没采到就当失败——空环境比继承环境更糟
      if (!env.PATH) return sanitize(process.env);
      return sanitize(env);
    } catch {
      return sanitize(process.env);
    }
  })();
  return cached;
}

// 测试钩子：重置缓存
export function resetShellEnvCache() {
  cached = null;
}

export { parseEnvOutput, sanitize };
