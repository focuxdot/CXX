// 拉起并驱动 codex app-server（JSON-RPC over WebSocket）
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { CachedProjects } from "./project-index.mjs";

export class AppServer {
  #command;
  #port;
  #child = null;
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #log;
  #closed = false;
  // 首页「按项目」聚合缓存：本地全量扫描一次分组，projects.list 命中即 0 往返（见 project-index.mjs）
  #projects = new CachedProjects(() => this.listThreads(5000));

  onNotification = () => {}; // (method, params)
  onServerRequest = () => {}; // (id, method, params) —— 审批等，需调用 respond(id, result)
  onStateChange = () => {}; // (healthy: bool) —— 引擎掉线/恢复时回调（远端诊断用）

  // 引擎当前是否可用（app-server 进程活着且 WS 已连上）
  get healthy() {
    return this.#ws !== null;
  }

  constructor({ command = "codex", port = 19271, log = () => {} } = {}) {
    this.#command = command;
    this.#port = port;
    this.#log = log;
  }

  get url() {
    return `ws://127.0.0.1:${this.#port}`;
  }

  async start() {
    this.#closed = false;
    await this.#spawnAndConnect();
  }

  async #spawnAndConnect() {
    this.#child = spawn(this.#command, ["app-server", "--listen", this.url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.#child.stderr.on("data", (chunk) => this.#log(`[app-server] ${chunk}`.trimEnd()));
    this.#child.on("exit", (code) => {
      this.#log(`app-server 退出（code=${code}）`);
      this.#ws = null;
      this.onStateChange(false);
      if (!this.#closed) {
        // 自动重拉，避免引擎崩溃导致远程永久不可用
        delay(2000).then(() => this.#spawnAndConnect().catch((err) => this.#log(String(err))));
      }
    });

    await this.#waitReady();
    await this.#connect();
  }

  async #waitReady() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.#port}/readyz`);
        if (res.ok) return;
      } catch {
        // 尚未就绪
      }
      await delay(200);
    }
    throw new Error("app-server 启动超时");
  }

  async #connect() {
    const ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("无法连接 app-server"));
    });
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onclose = () => {
      const wasHealthy = this.#ws !== null;
      this.#ws = null;
      for (const [, pending] of this.#pending) {
        pending.reject(new Error("app-server 连接断开"));
      }
      this.#pending.clear();
      if (wasHealthy) this.onStateChange(false);
    };
    this.#ws = ws;
    await this.request("initialize", {
      clientInfo: { name: "cxx-remote-daemon", version: "0.1.0" },
      // 计划模式（collaborationMode）、thread/goal 等在 experimental 能力门之后
      capabilities: { experimentalApi: true },
    });
    // 握手收尾：app-server 需收到 initialized 通知后才服务会话级方法
    // （thread/resume、thread/start、turn/start）；缺此步这些请求会挂起超时。
    this.notify("initialized", {});
    this.onStateChange(true);
  }

  notify(method, params = {}) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 我方请求的响应
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? "app-server 错误"));
      else resolve(msg.result);
      return;
    }
    // 服务端主动请求（有 id + method）：审批等，需要我方回 response
    if (msg.id !== undefined && msg.method) {
      try {
        this.onServerRequest(msg.id, msg.method, msg.params ?? {});
      } catch (err) {
        this.#log(`处理服务端请求失败: ${err.message}`);
      }
      return;
    }
    // 通知（有 method 无 id）
    if (msg.method) {
      try {
        this.onNotification(msg.method, msg.params ?? {});
      } catch (err) {
        this.#log(`处理通知失败: ${err.message}`);
      }
    }
  }

  // 应答服务端请求（审批决定）
  respond(id, result) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id, code, message) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  request(method, params = {}, timeoutMs = 15000) {
    if (!this.#ws) return Promise.reject(new Error("app-server 未连接"));
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`app-server 请求超时: ${method}`));
        }
      }, timeoutMs).unref?.();
    });
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  // 引擎 thread 条目 → 手机端精简视图（含 rollout path，仅 daemon 内部用）
  #mapThread(t) {
    return {
      id: t.id,
      preview: t.preview ?? "",
      name: t.name ?? null,
      cwd: t.cwd ?? "",
      updatedAt: t.updatedAt ?? null,
      source: t.source ?? "",
      status: t.status?.type ?? "unknown",
      path: t.path ?? null,
    };
  }

  // 分批拉取（供 sessions.list 分页应答）：一次客户端请求，daemon 内部翻若干页
  // app-server（引擎单页硬上限 100）拼成一帧，回传合并结果 + 末页游标。绝不整份历史
  // 一次发——会挤爆 relay 的 256KiB 帧上限（帧被丢/连接被关，客户端卡住）。列表行已不回
  // preview（仅无名会话回一小段）+ d2c 大帧 deflate 压缩（实测真实数据 ~5x），2000 条压后
  // 上线帧 ~120KiB，稳在上限内。由客户端带 nextCursor 继续下一批，projects 随批到达逐步补全。
  // cwd 给定时按项目过滤（引擎原生支持，服务端过滤，仅回该项目会话）——首页展开某项目
  // 时只拉它自己的会话，与总量无关，恒定有界。不给 cwd 即原行为。
  async listThreadsPage({ cursor = null, limit = 2000, cwd = null } = {}) {
    const target = Math.max(1, Math.min(2000, limit | 0)); // 封顶 2000：压缩后仍稳在 256KiB 内
    const items = [];
    let cur = cursor;
    // 引擎单页上限 100，故内部最多翻 ceil(target/100) 页才能凑够 target（+1 容错）
    const maxPages = Math.ceil(target / 100) + 1;
    for (let i = 0; i < maxPages && items.length < target; i++) {
      const params = { limit: 100 }; // 引擎单页上限
      if (cur) params.cursor = cur;
      if (cwd) params.cwd = cwd;
      const result = await this.request("thread/list", params);
      const batch = result?.data ?? [];
      items.push(...batch);
      cur = result?.nextCursor ?? null;
      if (!cur || batch.length === 0) break; // 到底了
    }
    return { items: items.map((t) => this.#mapThread(t)), nextCursor: cur };
  }

  // 首页「按项目」聚合：一次本地全量扫描分组（TTL 缓存 + 单飞），一帧回全部项目，
  // 与会话总量无关地只需 1 次往返。运行/审批徽标由 client-session 实时从 hub 叠加。
  aggregateProjects() {
    return this.#projects.get();
  }

  // 会话集合变化（新建会话等）后调用，令下次 projects.list 重新扫描而非等 TTL 过期。
  invalidateProjects() {
    this.#projects.invalidate();
  }

  // 按 id 直接读单个会话（thread/read 返回含 rollout path 的 Thread）。
  // watch/share 用它解析会话文件路径，不再依赖 listThreads 扫描——排在很深处的
  // 老会话（翻很多页才到）也能被正确解析、打开。
  async readThread(threadId) {
    try {
      const result = await this.request("thread/read", { threadId });
      return result?.thread ? this.#mapThread(result.thread) : null;
    } catch {
      return null;
    }
  }

  // 跨页累计到 limit（daemon 内部用：昵称缓存等）。会去重、按更新时间新→旧排序。
  // 注意：结果体量可能很大，切勿整份塞进单个 E2E 帧发给客户端（用 listThreadsPage）。
  async listThreads(limit = 1000) {
    const target = Math.max(1, limit | 0);
    const pageSize = Math.min(100, target); // 引擎单页上限 100
    const items = [];
    let cursor = null;
    for (let guard = 0; guard < 60 && items.length < target; guard++) {
      const params = { limit: pageSize };
      if (cursor) params.cursor = cursor;
      const result = await this.request("thread/list", params);
      const batch = result?.data ?? [];
      items.push(...batch);
      cursor = result?.nextCursor ?? null;
      if (!cursor || batch.length === 0) break; // 没有下一页了
    }
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      if (it?.id && !seen.has(it.id)) {
        seen.add(it.id);
        unique.push(it);
      }
    }
    unique.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return unique.slice(0, target).map((t) => this.#mapThread(t));
  }

  // 会话级方法可能因模型初始化/网络（如国内访问模型列表）而较慢，
  // 用更长的超时；实测 resume 在网络不佳时约 16s。
  #SESSION_TIMEOUT = 90000;

  // 恢复会话到本 app-server 实例（幂等，daemon 侧去重）
  resumeThread(threadId, overrides = {}) {
    return this.request("thread/resume", { threadId, ...overrides }, this.#SESSION_TIMEOUT);
  }

  // 发起一轮对话（input 为字符串，或 turn/start 输入项数组——文本+图片混合时用后者），
  // 返回 { turnId? }
  startTurn(threadId, input, overrides = {}) {
    const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
    return this.request(
      "turn/start",
      { threadId, input: items, ...overrides },
      this.#SESSION_TIMEOUT,
    );
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  startThread(params = {}) {
    return this.request("thread/start", params, this.#SESSION_TIMEOUT);
  }

  forkThread(threadId) {
    return this.request("thread/fork", { threadId, excludeTurns: true }, this.#SESSION_TIMEOUT);
  }

  stop() {
    this.#closed = true;
    this.#ws?.close();
    this.#child?.kill();
  }
}
