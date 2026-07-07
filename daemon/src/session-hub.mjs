// 会话驱动中枢：连接 app-server 的事件/审批与各手机端连接。
// - 客户端表：所有已鉴权设备（审批广播、看板变更通知）
// - 订阅表：谁在看某会话（转发流式事件）
// - 审批表：待决策的服务端请求（广播给所有设备，任一设备可决策，先到先得）
// 见 public/PROTOCOL.md §3。
export class SessionHub {
  #appServer;
  #log;
  #clients = new Set(); // 已鉴权的 ClientSession
  #subscribers = new Map(); // threadId -> Set<ClientSession>
  #resumed = new Set(); // 已 resume 到本 app-server 的 threadId
  #currentTurn = new Map(); // threadId -> turnId（用于 interrupt 与运行状态）
  #approvals = new Map(); // approvalKey -> { requestId, threadId, method, params }
  #nextApproval = 1;
  #onAwakeChange;
  #awake = false;
  #onEvent;

  #onViewersChange;
  // —— 围观层互动（daemon 自己的通知广播，与 rollout/turn 完全不同路，绝不进 agent 上下文）——
  #reactionBuf = new Map(); // sessionId -> Map<emoji, count>（1s 合并窗口）
  #reactionTimer = null;
  #reactionWindowMs;
  #viewerCountDirty = new Set(); // 待广播 viewer.count 的 sessionId
  #viewerCountTimer = null;
  #viewerCountDebounceMs;
  #congested = new Map(); // sessionId -> bool（拥塞状态，翻转时补发 viewer.count）
  #congestionTimer = null;
  #congestionTickMs;
  #congestionAfterMs;
  #linkStats = new Map(); // deviceId -> {sessionId, visitors, peak, reactions}（内存，重启即清）

  // 本 hub 归属的 agent（codex / claude）。审批 key 是各 hub 独立计数器（a1,a2…），
  // 跨 hub 会撞号——审批通知带上 agent，手机据此把 approval.respond 路由到正确的 hub。
  #agent = "codex";

  constructor(appServer, {
    log = () => {},
    agent = "codex",
    onAwakeChange = () => {},
    onEvent = () => {},
    onViewersChange = () => {},
    reactionWindowMs = 1000,
    viewerCountDebounceMs = 500,
    congestionTickMs = 3000,
    congestionAfterMs = 3000,
  } = {}) {
    this.#appServer = appServer;
    this.#log = log;
    this.#agent = agent;
    this.#onAwakeChange = onAwakeChange;
    this.#onEvent = onEvent; // (type, {sessionId, clientsOnline}) —— webhook 通知用
    this.#onViewersChange = onViewersChange; // 观众上下线（viewer-status 落盘 / viewer.count 广播）
    this.#reactionWindowMs = reactionWindowMs;
    this.#viewerCountDebounceMs = viewerCountDebounceMs;
    this.#congestionTickMs = congestionTickMs;
    this.#congestionAfterMs = congestionAfterMs;
    appServer.onNotification = (method, params) => this.#onNotification(method, params);
    appServer.onServerRequest = (id, method, params) => this.#onServerRequest(id, method, params);
    // 后端撤回一条审批（如 Claude 轮次被打断/结束，等待中的工具审批已无处落地）：
    // 移除待决条目并让各设备的审批卡片消失。codex app-server 不触发此回调（无害默认）。
    appServer.onServerRequestCancel = (id) => this.#onServerRequestCancel(id);
  }

  // 需要保持清醒：有设备在线（用户可能随时操作）或有会话运行中（任务不能被睡眠打断）
  shouldStayAwake() {
    return this.#clients.size > 0 || this.#currentTurn.size > 0;
  }

  #updateAwake() {
    const want = this.shouldStayAwake();
    if (want === this.#awake) return;
    this.#awake = want;
    this.#onAwakeChange(want);
  }

  // —— 设备注册（鉴权成功后调用）——
  registerClient(client) {
    this.#clients.add(client);
    // 新设备上线立即补发所有待决审批，避免"审批在没人看的时候发生"。
    // 观众除外：审批内容（命令原文、diff）不该出现在观众的通知面上。
    if (!client.isViewer) {
      for (const [key, entry] of this.#approvals) {
        client.pushApproval(key, entry.threadId, entry.method, entry.params, this.#agent);
      }
    } else {
      // 战报计数（visitors 累计 / peak 该链接并发峰值）——内存态，重启即清
      const stats = this.#statsFor(client.deviceId, client.scopeSessionId);
      if (stats) {
        stats.visitors += 1;
        stats.peak = Math.max(stats.peak, this.viewerCountByDevice(client.deviceId));
      }
      this.#markViewersChanged(client.scopeSessionId);
      this.#ensureCongestionWatch();
      this.#onViewersChange();
    }
    this.#updateAwake();
  }

  #statsFor(deviceId, sessionId) {
    if (!deviceId) return null;
    let stats = this.#linkStats.get(deviceId);
    if (!stats) {
      stats = { sessionId: sessionId ?? null, visitors: 0, peak: 0, reactions: 0 };
      this.#linkStats.set(deviceId, stats);
    }
    return stats;
  }

  // 某会话的在线观众数：按 scope.sessionId 聚合（同一会话的全部围观链接计入
  // 同一个数——按 deviceId 计数会被"多铸一条链接"静默绕过）。熔断与观众计数用。
  viewerCount(sessionId) {
    if (!sessionId) return 0;
    let n = 0;
    for (const client of this.#clients) {
      if (client.isViewer && client.scopeSessionId === sessionId) n++;
    }
    return n;
  }

  // 单条围观链接的在线观众数（分享弹窗按链接展示用；熔断仍按会话聚合）
  viewerCountByDevice(deviceId) {
    let n = 0;
    for (const client of this.#clients) {
      if (client.isViewer && client.deviceId === deviceId) n++;
    }
    return n;
  }

  // 全部在线观众按 deviceId 聚合（viewer-status 落盘用，桌面设备页读取）
  viewerStats() {
    const byDevice = {};
    for (const client of this.#clients) {
      if (!client.isViewer || !client.deviceId) continue;
      byDevice[client.deviceId] = (byDevice[client.deviceId] ?? 0) + 1;
    }
    return byDevice;
  }

  // —— 围观层互动：喝彩聚合（1s 合并窗口，无文字即无骂人/无审核/无注入面）——
  addReaction(sessionId, emoji, deviceId) {
    if (!sessionId) return;
    if (!this.#reactionBuf.has(sessionId)) this.#reactionBuf.set(sessionId, new Map());
    const byEmoji = this.#reactionBuf.get(sessionId);
    byEmoji.set(emoji, (byEmoji.get(emoji) ?? 0) + 1);
    const stats = deviceId ? this.#linkStats.get(deviceId) : null;
    if (stats) stats.reactions += 1;
    if (!this.#reactionTimer) {
      this.#reactionTimer = setTimeout(() => {
        this.#reactionTimer = null;
        this.#flushReactions();
      }, this.#reactionWindowMs);
      this.#reactionTimer.unref?.();
    }
  }

  #flushReactions() {
    for (const [sessionId, byEmoji] of this.#reactionBuf) {
      for (const [emoji, count] of byEmoji) {
        this.#pushToSessionAudience(sessionId, (client) =>
          client.pushShareReaction?.({ sessionId, emoji, count }));
      }
    }
    this.#reactionBuf.clear();
  }

  // 会话的"观众面"：全部全权设备（分享者在任何页面都能看到喝彩/人数）+ 该会话的观众
  #pushToSessionAudience(sessionId, push) {
    for (const client of this.#clients) {
      if (client.isViewer && client.scopeSessionId !== sessionId) continue;
      push(client);
    }
  }

  // —— viewer.count：观众进出防抖广播；congested 仅发全权设备 ——
  #markViewersChanged(sessionId) {
    if (!sessionId) return;
    this.#viewerCountDirty.add(sessionId);
    if (this.#viewerCountTimer) return;
    this.#viewerCountTimer = setTimeout(() => {
      this.#viewerCountTimer = null;
      const dirty = [...this.#viewerCountDirty];
      this.#viewerCountDirty.clear();
      for (const sid of dirty) this.#broadcastViewerCount(sid);
    }, this.#viewerCountDebounceMs);
    this.#viewerCountTimer.unref?.();
  }

  #broadcastViewerCount(sessionId) {
    const count = this.viewerCount(sessionId);
    const congested = this.#congested.get(sessionId) === true;
    this.#pushToSessionAudience(sessionId, (client) =>
      client.pushViewerCount?.(
        client.isViewer ? { sessionId, count } : { sessionId, count, congested }));
  }

  // 观众帧持续积压 >3s 判为拥塞；状态翻转时补发一次 viewer.count 让分享者看得见。
  // 定时器只在有观众时运转（懒启动，无观众即停）。
  #ensureCongestionWatch() {
    if (this.#congestionTimer) return;
    this.#congestionTimer = setInterval(() => {
      const bySession = new Map(); // sid -> 拥塞与否
      let anyViewer = false;
      for (const client of this.#clients) {
        if (!client.isViewer || !client.scopeSessionId) continue;
        anyViewer = true;
        const sid = client.scopeSessionId;
        const jammed =
          client.congestedSince > 0 && Date.now() - client.congestedSince > this.#congestionAfterMs;
        bySession.set(sid, (bySession.get(sid) ?? false) || jammed);
      }
      for (const [sid, jammed] of bySession) {
        if ((this.#congested.get(sid) === true) !== jammed) {
          this.#congested.set(sid, jammed);
          this.#broadcastViewerCount(sid);
        }
      }
      for (const sid of [...this.#congested.keys()]) {
        if (!bySession.has(sid)) {
          // 拥塞会话的观众全走了也要广播翻转，否则分享者端「围观人数较多」悬挂
          const wasJammed = this.#congested.get(sid) === true;
          this.#congested.delete(sid);
          if (wasJammed) this.#broadcastViewerCount(sid);
        }
      }
      if (!anyViewer) {
        clearInterval(this.#congestionTimer);
        this.#congestionTimer = null;
      }
    }, this.#congestionTickMs);
    this.#congestionTimer.unref?.();
  }

  // —— 围观战报：链接撤销/过期时向全权设备交出计数（内存态，重启即清）——
  finishLink(deviceId) {
    const stats = this.#linkStats.get(deviceId);
    if (!stats) return;
    this.#linkStats.delete(deviceId);
    if (stats.visitors === 0) return; // 没人来过的链接没有战报可言
    for (const client of this.#clients) {
      if (client.isViewer) continue;
      client.pushShareSummary?.({
        sessionId: stats.sessionId,
        deviceId,
        visitors: stats.visitors,
        peak: stats.peak,
        reactions: stats.reactions,
      });
    }
  }

  // 对账：统计里还挂着、但配置中已消失/已过期的链接（桌面端撤销或到期时
  // 观众可能早已离线，enforceDevices 踢不到任何连接），也要交出战报并清统计
  reconcileLinks(validDeviceIds) {
    for (const deviceId of [...this.#linkStats.keys()]) {
      if (!validDeviceIds.has(deviceId)) this.finishLink(deviceId);
    }
  }

  // —— 订阅（查看） ——
  subscribe(threadId, client) {
    if (!this.#subscribers.has(threadId)) this.#subscribers.set(threadId, new Set());
    this.#subscribers.get(threadId).add(client);
  }

  unsubscribe(threadId, client) {
    this.#subscribers.get(threadId)?.delete(client);
    if (this.#subscribers.get(threadId)?.size === 0) this.#subscribers.delete(threadId);
  }

  // 引擎（app-server）掉线/恢复时广播给所有设备（连接状态分层诊断用）
  broadcastEngineState(healthy) {
    for (const client of this.#clients) client.pushEngineState(healthy);
  }

  // —— 看板状态 ——
  isRunning(threadId) {
    return this.#currentTurn.has(threadId);
  }

  approvalCount(threadId) {
    let n = 0;
    for (const entry of this.#approvals.values()) if (entry.threadId === threadId) n++;
    return n;
  }

  // —— 项目徽标数据源（projects.list 实时叠加用）——
  // 正在被本 daemon 驱动的会话 id（小集合：#currentTurn）。
  runningThreadIds() {
    return [...this.#currentTurn.keys()];
  }

  // 待决审批按会话计数：threadId -> count（小集合：#approvals）。
  approvalsByThread() {
    const m = new Map();
    for (const entry of this.#approvals.values()) {
      m.set(entry.threadId, (m.get(entry.threadId) || 0) + 1);
    }
    return m;
  }

  // —— 驱动：确保会话已 resume，然后发消息 ——
  // imageUrls：data: URL 数组（手机上传的附图）。桌面端对 data URL 同样走
  // {type:"image",url} 输入项，这是已验证的路径，不需要落临时文件。
  // overrides：按轮 override（model/effort/approvalPolicy/sandboxPolicy/plan，
  // 已在 client-session 白名单过滤）。plan 展开为 collaborationMode（实测形状：
  // {mode:"plan",settings:{model}}，settings.model 必填，缺省用引擎默认模型）
  async sendMessage(threadId, text, imageUrls = [], overrides) {
    await this.#ensureResumed(threadId);
    const input = [
      ...imageUrls.map((url) => ({ type: "image", url })),
      ...(text ? [{ type: "text", text }] : []),
    ];
    const { plan, ...rest } = overrides ?? {};
    if (plan) {
      const model = rest.model ?? (await this.#defaultModel());
      rest.collaborationMode = {
        mode: "plan",
        settings: { model, ...(rest.effort ? { effort: rest.effort } : {}) },
      };
    }
    const result = await this.#appServer.startTurn(threadId, input, rest);
    const turnId = result?.turnId ?? result?.turn?.id ?? null;
    if (turnId) this.#currentTurn.set(threadId, turnId);
    this.#updateAwake();
    this.#broadcastBoard(threadId);
    return { turnId };
  }

  async interrupt(threadId) {
    const turnId = this.#currentTurn.get(threadId);
    if (!turnId) return { ok: false, reason: "无进行中的轮次" };
    await this.#appServer.interruptTurn(threadId, turnId);
    return { ok: true };
  }

  // —— 会话目标（官方 App 的 Pursue goal）——
  async setGoal(threadId, goal) {
    await this.#ensureResumed(threadId);
    if (goal) {
      await this.#appServer.request("thread/goal/set", { threadId, goal });
    } else {
      await this.#appServer.request("thread/goal/clear", { threadId });
    }
    return { ok: true };
  }

  async getGoal(threadId) {
    await this.#ensureResumed(threadId);
    try {
      const r = await this.#appServer.request("thread/goal/get", { threadId });
      // 响应形状未定稿（experimental）：兼容 {goal} / {data:{goal}} / {data:"..."}
      const goal = r?.goal ?? r?.data?.goal ?? (typeof r?.data === "string" ? r.data : null);
      return { goal: typeof goal === "string" ? goal : null };
    } catch {
      return { goal: null };
    }
  }

  // 引擎默认模型（计划模式 settings.model 必填时的兜底），进程内缓存一次
  #modelDefault = null;
  async #defaultModel() {
    if (this.#modelDefault) return this.#modelDefault;
    const r = await this.#appServer.request("model/list", {});
    const models = r?.data ?? [];
    this.#modelDefault = (models.find((m) => m.isDefault) ?? models[0])?.model ?? "gpt-5.5";
    return this.#modelDefault;
  }

  async newThread(cwd) {
    const result = await this.#appServer.startThread(cwd ? { cwd } : {});
    const threadId = result?.threadId ?? result?.thread?.id ?? result?.id ?? null;
    if (threadId) this.#resumed.add(threadId);
    // 会话集合变了：让下次 projects.list 立即重扫，新会话的项目不必等 TTL 才出现
    this.#appServer.invalidateProjects?.();
    return { threadId };
  }

  async startSession(cwd, text, imageUrls = [], overrides) {
    const result = await this.#appServer.startThread(cwd ? { cwd } : {});
    const threadId = result?.threadId ?? result?.thread?.id ?? result?.id ?? null;
    if (!threadId) throw new Error("未返回会话 id");
    this.#resumed.add(threadId);
    const turn = await this.sendMessage(threadId, text, imageUrls, overrides);
    this.#appServer.invalidateProjects?.();
    return { threadId, turnId: turn?.turnId ?? null };
  }

  async forkThread(threadId) {
    const result = await this.#appServer.forkThread(threadId);
    const forked = result?.thread ?? {};
    const forkedId = result?.threadId ?? forked.id ?? result?.id ?? null;
    if (forkedId) this.#resumed.add(forkedId);
    this.#appServer.invalidateProjects?.();
    return { threadId: forkedId, cwd: result?.cwd ?? forked.cwd ?? "" };
  }

  async #ensureResumed(threadId) {
    if (this.#resumed.has(threadId)) return;
    await this.#appServer.resumeThread(threadId);
    this.#resumed.add(threadId);
  }

  // —— 审批决策（任一已配对设备可决策，先到先得）——
  respondApproval(approvalKey, decision) {
    const entry = this.#approvals.get(approvalKey);
    if (!entry) return { ok: false, reason: "审批不存在或已被处理" };
    this.#approvals.delete(approvalKey);
    this.#appServer.respond(entry.requestId, { decision });
    // 其他设备的审批卡片同步消失（观众本就收不到审批，resolved 也不发）
    for (const client of this.#clients) {
      if (client.isViewer) continue;
      client.pushApprovalResolved(approvalKey, this.#agent);
    }
    this.#broadcastBoard(entry.threadId);
    return { ok: true };
  }

  // —— app-server -> 手机 ——
  #onNotification(method, params) {
    const threadId = params?.threadId;
    if (!threadId) return;
    if (method === "turn/started") {
      const turnId = params?.turn?.id ?? params?.turnId;
      if (turnId) this.#currentTurn.set(threadId, turnId);
      this.#updateAwake();
      this.#broadcastBoard(threadId);
    }
    // failed/aborted 同样要清运行状态，否则看板"运行中"永远卡住
    if (method === "turn/completed" || method === "turn/failed" || method === "turn/aborted") {
      this.#currentTurn.delete(threadId);
      this.#updateAwake();
      this.#broadcastBoard(threadId);
      if (method === "turn/completed") {
        this.#onEvent("turnCompleted", { sessionId: threadId, clientsOnline: this.#clients.size });
      }
    }
    const subs = this.#subscribers.get(threadId);
    if (!subs) return;
    for (const client of subs) {
      client.pushLiveEvent(threadId, method, params);
    }
  }

  #onServerRequest(id, method, params) {
    const threadId = params?.threadId;
    const isApproval = /requestApproval|Approval$/.test(method);
    if (!isApproval || !threadId) {
      // 非审批的服务端请求，daemon 暂不支持，回错误避免 app-server 卡住
      this.#appServer.respondError(id, -32601, `daemon 不处理该请求: ${method}`);
      return;
    }
    // key 带 agent 前缀全局唯一：旧客户端不回填 agent 时 approval.respond 缺省路由
    // codex hub，若各 hub 都用裸 a1/a2 会撞号、把决策批到另一个 agent 的审批上。
    // 前缀化后错投至多"未命中"（client-session 会跨 hub 兜底查找），不可能批错。
    const approvalKey = `${this.#agent}-a${this.#nextApproval++}`;
    this.#approvals.set(approvalKey, { requestId: id, threadId, method, params });
    if (this.#clients.size === 0) {
      this.#log(`审批 ${approvalKey} 暂无在线设备，挂起等待（设备上线后补发）`);
    }
    // 广播给所有全权设备：审批是头号阻塞，必须在任何页面都能看到。
    // 观众无法决策，命令原文与 diff 也不该达至观众端。
    for (const client of this.#clients) {
      if (client.isViewer) continue;
      client.pushApproval(approvalKey, threadId, method, params, this.#agent);
    }
    this.#broadcastBoard(threadId);
    // webhook：审批是头号阻塞，总是推（无论是否有设备在线）
    this.#onEvent("approval", { sessionId: threadId, clientsOnline: this.#clients.size });
  }

  // 后端撤回审批（requestId 定位）：删待决条目、通知各设备卡片消失、刷看板。
  // 与手机决策的 respondApproval 对称，只是发起方是后端而非设备。
  #onServerRequestCancel(requestId) {
    for (const [approvalKey, entry] of this.#approvals) {
      if (entry.requestId !== requestId) continue;
      this.#approvals.delete(approvalKey);
      for (const client of this.#clients) {
        if (client.isViewer) continue;
        client.pushApprovalResolved(approvalKey, this.#agent);
      }
      this.#broadcastBoard(entry.threadId);
      return;
    }
  }

  // 看板变更（运行状态/审批数变化），客户端据此刷新列表徽标。
  // 不发观众：它携带其他会话的运行状态与审批数（观众端也无看板）。
  #broadcastBoard(threadId) {
    const payload = {
      sessionId: threadId,
      running: this.isRunning(threadId),
      approvals: this.approvalCount(threadId),
    };
    for (const client of this.#clients) {
      if (client.isViewer) continue;
      client.pushBoardChanged(payload);
    }
  }

  // client 断开时清理
  removeClient(client) {
    const wasViewer = this.#clients.has(client) && client.isViewer;
    this.#clients.delete(client);
    for (const [threadId, subs] of this.#subscribers) {
      subs.delete(client);
      if (subs.size === 0) this.#subscribers.delete(threadId);
    }
    if (wasViewer) {
      this.#markViewersChanged(client.scopeSessionId);
      this.#onViewersChange();
    }
    this.#updateAwake();
  }
}
