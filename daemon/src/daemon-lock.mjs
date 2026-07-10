// 每个配置文件只允许一个 daemon。否则两个进程会使用同一个 daemonId 接入 relay，
// 新连接顶掉旧连接，旧进程再自动重连，形成持续的“互相踢下线”循环。
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export class DaemonAlreadyRunningError extends Error {
  constructor(pid) {
    super(`CXX 后台服务已在运行（pid=${pid}），拒绝启动第二个实例`);
    this.name = "DaemonAlreadyRunningError";
    this.pid = pid;
  }
}

export function daemonLockPath(configPath) {
  return join(dirname(configPath), "daemon.lock");
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function acquireDaemonLock(configPath, { pid = process.pid, alive = isProcessAlive } = {}) {
  const path = daemonLockPath(configPath);
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // 删除一个已确认死亡的陈旧锁后再争抢一次；wx 保证并发启动只能有一个胜出。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid, token, startedAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return { path, pid, token };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    let existing;
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // 另一进程可能刚用 wx 创建、尚未写完锁文件；宁可拒绝本次启动，也不能删它的锁。
      throw new Error("CXX 后台服务正在启动，请稍后重试");
    }
    if (alive(existing?.pid)) throw new DaemonAlreadyRunningError(existing.pid);

    try {
      unlinkSync(path);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  throw new Error("无法获取 CXX daemon 单实例锁");
}

export function releaseDaemonLock(lock) {
  if (!lock?.path || !lock.token) return;
  try {
    const current = JSON.parse(readFileSync(lock.path, "utf8"));
    // 锁可能已被后续实例接管；只允许拥有者释放自己的锁。
    if (current?.token === lock.token) unlinkSync(lock.path);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}
