// PtyAdapter：cxx-pty-host 的 IPC client（见 internal/TERMINAL-MODE.md §7）。
// daemon 侧唯一接触 PTY 的边界。host 是独立进程（detached），daemon 重启不杀终端；
// 重启后通过 listPtyHosts 扫描注册目录 + reattach 恢复。
//
// 帧协议与 pty-host/main.go 顶部注释一致：uint32LE len | uint8 type | payload。
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PTY_PROTO_V = 1;

const T = {
  ATTACH: 1,
  WRITE: 2,
  RESIZE: 3,
  SIGNAL: 4,
  CLOSE: 5,
  META: 6,
  HELLO: 0x81,
  OUTPUT: 0x82,
  EXIT: 0x83,
  META_R: 0x84,
  REPLAY_END: 0x85,
};

const SIG = { interrupt: 1, eof: 2, term: 3, kill: 4 };

function frame(type, payload = Buffer.alloc(0)) {
  const f = Buffer.alloc(5 + payload.length);
  f.writeUInt32LE(payload.length, 0);
  f[4] = type;
  payload.copy(f, 5);
  return f;
}

// 单个 host 连接。事件：hello / data(seq, buf) / replayEnd({from,gap,next}) /
// exit({code,signal}) / meta(obj) / close / error。
export class PtyHostClient extends EventEmitter {
  #sock = null;
  #buf = Buffer.alloc(0);

  constructor(sock) {
    super();
    this.#sock = sock;
    sock.on("data", (d) => this.#onData(d));
    // 无监听者时不重抛（disconnect/host 自灭产生的错误不该炸掉进程）
    sock.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
    sock.on("close", () => this.emit("close"));
  }

  #onData(d) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
    while (this.#buf.length >= 5) {
      const len = this.#buf.readUInt32LE(0);
      // 帧长上限（host OUTPUT 分块 ≤32KiB，元数据帧更小）：坏/敌意 host socket 声明
      // 4GiB 长度会让 daemon 无界缓冲直至 OOM。超限即判协议错、断开。
      if (len > 8 * 1024 * 1024) {
        this.#sock.destroy();
        if (this.listenerCount("error") > 0) this.emit("error", new Error(`pty-host 帧过大: ${len}`));
        return;
      }
      if (this.#buf.length < 5 + len) return;
      const type = this.#buf[4];
      const payload = this.#buf.subarray(5, 5 + len);
      this.#buf = this.#buf.subarray(5 + len);
      this.#dispatch(type, payload);
    }
  }

  #dispatch(type, payload) {
    switch (type) {
      case T.HELLO:
        this.emit("hello", JSON.parse(payload.toString("utf8")));
        break;
      case T.OUTPUT: {
        const seq = payload.readBigUInt64LE(0);
        this.emit("data", Number(seq), Buffer.from(payload.subarray(8)));
        break;
      }
      case T.REPLAY_END:
        this.emit("replayEnd", JSON.parse(payload.toString("utf8")));
        break;
      case T.EXIT:
        this.emit("exit", JSON.parse(payload.toString("utf8")));
        break;
      case T.META_R:
        this.emit("meta", JSON.parse(payload.toString("utf8")));
        break;
    }
  }

  attach(sinceSeq = 0) {
    const p = Buffer.alloc(8);
    p.writeBigUInt64LE(BigInt(sinceSeq), 0);
    this.#sock.write(frame(T.ATTACH, p));
  }

  write(data) {
    this.#sock.write(frame(T.WRITE, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")));
  }

  resize(cols, rows) {
    const p = Buffer.alloc(4);
    p.writeUInt16LE(cols, 0);
    p.writeUInt16LE(rows, 2);
    this.#sock.write(frame(T.RESIZE, p));
  }

  signal(kind) {
    const code = SIG[kind];
    if (!code) throw new Error(`unknown signal: ${kind}`);
    this.#sock.write(frame(T.SIGNAL, Buffer.from([code])));
  }

  requestMeta() {
    this.#sock.write(frame(T.META));
  }

  // 结束子进程（host 先 SIGTERM，5s 后 SIGKILL，然后自灭）
  close() {
    this.#sock.write(frame(T.CLOSE));
  }

  // 仅断开本连接，host 与子进程继续运行（detach 语义）
  disconnect() {
    this.#sock.destroy();
  }
}

function sockTarget(dir) {
  // unix: sock 即 socket 文件；windows: sock 文件内容是 named pipe 名
  const p = join(dir, "sock");
  if (process.platform === "win32") return readFileSync(p, "utf8").trim();
  return p;
}

function connectOnce(dir, sinceSeq) {
  return new Promise((resolve, reject) => {
    let sock;
    try {
      sock = createConnection(sockTarget(dir));
    } catch (err) {
      reject(err);
      return;
    }
    const onConnErr = (err) => reject(err);
    sock.once("error", onConnErr);
    sock.once("connect", () => {
      sock.removeListener("error", onConnErr);
      const client = new PtyHostClient(sock);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("pty-host hello timeout"));
      }, 3000);
      client.once("hello", (hello) => {
        clearTimeout(timer);
        if (hello.v !== PTY_PROTO_V) {
          sock.destroy();
          reject(new Error(`pty-host 协议版本不匹配: host=${hello.v} client=${PTY_PROTO_V}`));
          return;
        }
        client.attach(sinceSeq);
        resolve({ client, hello });
      });
    });
  });
}

// 连接既有 host 并 attach。返回 { client, hello }。
export async function reattachPtyHost({ dir, sinceSeq = 0, timeoutMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await connectOnce(dir, sinceSeq);
    } catch (err) {
      lastErr = err;
      if (String(err?.message).includes("协议版本不匹配")) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastErr ?? new Error("pty-host connect timeout");
}

// 创建新终端：写 spawn.json → detached 拉起 host → 连接。
// spec: { executable, args, cwd, env, cols, rows, ringBytes, meta }
export async function spawnPtyHost({ hostBin, dir, spec, timeoutMs = 5000 }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "spawn.json"), JSON.stringify(spec), { mode: 0o600 });
  const child = spawn(hostBin, ["--dir", dir], {
    detached: true, // 新 session：daemon 死了 host 不陪葬（连续性支柱）
    stdio: "ignore",
  });
  child.unref();
  const spawnFailed = new Promise((_, reject) => {
    child.once("error", (err) => reject(new Error(`spawn pty-host: ${err.message}`)));
  });
  try {
    return await Promise.race([reattachPtyHost({ dir, sinceSeq: 0, timeoutMs }), spawnFailed]);
  } catch (err) {
    // 带上 host 侧日志帮助诊断 spawn 失败
    let tail = "";
    try {
      tail = readFileSync(join(dir, "host.log"), "utf8").split("\n").slice(-5).join("\n");
    } catch {}
    throw new Error(`${err.message}${tail ? `\nhost.log:\n${tail}` : ""}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// 扫描注册目录（daemon 启动时重建会话列表）。
// 返回 [{ terminalId, dir, alive, hostPid, childPid, startedAt, meta, exit }]
export function listPtyHosts(baseDir) {
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(baseDir, e.name);
    const meta = readJson(join(dir, "meta.json"));
    if (!meta) continue;
    const exit = readJson(join(dir, "exit.json"));
    const alive = existsSync(join(dir, "pid")) && pidAlive(meta.hostPid) && existsSync(join(dir, "sock"));
    out.push({
      terminalId: e.name,
      dir,
      alive,
      hostPid: meta.hostPid,
      childPid: meta.childPid,
      startedAt: meta.startedAt,
      meta: meta.meta ?? null,
      exit,
    });
  }
  return out;
}

// 回收一个会话目录（终端已结束且 daemon 决定不再保留时）。
export function removePtyHostDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// 定位 cxx-pty-host 二进制（internal/TERMINAL-MODE.md §15.2 候选布局）。
// 找不到返回 null——daemon 照常启动，只是不声明 terminal 能力（§16 故障语义）。
export function resolvePtyHostBin(configured) {
  const exe = process.platform === "win32" ? "cxx-pty-host.exe" : "cxx-pty-host";
  const execDir = dirname(process.execPath);
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  const candidates = [
    configured, // config.ptyHostPath 显式覆盖优先
    join(execDir, exe), // 与 daemon 二进制同目录（Windows/Linux 安装布局）
    join(execDir, "..", "Resources", "bin", exe), // macOS .app 布局
    join(repo, "dist", "pty-host", `${goos}-${goarch}`, exe), // 源码运行：交叉编译产物
    join(repo, "dist", "pty-host", "dev", exe), // 源码运行：smoke 的本机 dev 构建
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
