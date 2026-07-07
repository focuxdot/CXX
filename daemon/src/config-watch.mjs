// 监听 daemon.json 变更：桌面端撤销设备走独立 CLI 进程的文件写，
// daemon 必须自己发现并对已撤销/过期的在线连接立即踢断（"随时踢"的承诺）。
// fs.watch 主路 + 低频 stat 轮询兜底（模式同 rollout-tail 的双保险），
// 300ms 防抖把连续写盘（如 CLI 的读改写）合并成一次回调。
// daemon 自己写盘也会触发回调——上层 enforce 是幂等的（设备还在→不踢），无需区分来源。
import { existsSync, watch } from "node:fs";
import { stat } from "node:fs/promises";

import { isDeviceExpired, loadOrCreateConfig } from "./config.mjs";

// 设备表核对：从盘上重读配置，对已不在设备表中或已过期的在线连接立即踢断。
// 覆盖三条路径：桌面设备页撤销（独立 CLI 进程写文件）、share.revoke（daemon
// 自己写盘后经这里兜底）、expiresAt 到期（定时触发——否则限时是假的）。
// 同时补上存量缺口：全权设备撤销此前只对下次鉴权生效，在线长连接不受影响。
export function enforceDevices({ configPath, listConnections, onConfig = () => {}, onKicked = () => {}, log = () => {} }) {
  // 文件不存在时跳过而非 loadOrCreateConfig：后者会重新生成一份空白配置写盘
  // （新 daemonId/空设备表），等于把全部设备踢光、令牌作废——误删/原子替换的
  // 瞬间窗口都不该有这种毁灭性副作用
  if (!existsSync(configPath)) {
    log("配置文件不存在，跳过本轮设备核对");
    return;
  }
  let fresh;
  try {
    fresh = loadOrCreateConfig(configPath);
  } catch (err) {
    log(`配置重读失败，跳过本轮设备核对: ${err.message}`);
    return;
  }
  onConfig(fresh);
  const byId = new Map((fresh.devices ?? []).map((d) => [d.deviceId, d]));
  for (const session of listConnections()) {
    const id = session.deviceId;
    if (!id) continue; // 未鉴权连接由 auth 自己把关
    const device = byId.get(id);
    if (!device || isDeviceExpired(device)) {
      log(`设备 ${id} 已撤销或过期，断开其在线连接`);
      session.kick();
      onKicked(session); // 围观链接的战报等收尾（main 里接 hub.finishLink）
    }
  }
}

export function watchConfig(configPath, { onChange, pollMs = 3000, debounceMs = 300 } = {}) {
  let closed = false;
  let debounce = null;
  let lastMtime = -1; // -1 = 尚未取得基线，首次 stat 只记录不触发

  const fire = () => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!closed) onChange();
    }, debounceMs);
    debounce.unref?.();
  };

  let watcher = null;
  try {
    watcher = watch(configPath, fire);
    // FSWatcher 的异步 error 事件（如目录被移除）没有监听会直接崩掉进程；
    // 关掉坏 watcher 即可，轮询兜底仍然工作
    watcher.on("error", () => {
      try { watcher.close(); } catch {}
      watcher = null;
    });
  } catch {
    // 文件暂不存在等场景：轮询兜底仍然工作
  }

  const poller = setInterval(async () => {
    try {
      const info = await stat(configPath);
      if (info.mtimeMs !== lastMtime) {
        const isBaseline = lastMtime === -1;
        lastMtime = info.mtimeMs;
        if (!isBaseline) fire();
      }
    } catch {
      // 文件暂不可读：下个周期再试
    }
  }, pollMs);
  poller.unref?.();

  return {
    close() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      clearInterval(poller);
    },
  };
}
