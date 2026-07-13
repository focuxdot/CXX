// 单个远端设备连接的 E2E 会话：握手 -> 鉴权 -> 方法路由（见 PROTOCOL.md §2/§3）
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import {
  APP_PROTOCOL,
  consumePairToken,
  findDeviceByToken,
  isDeviceExpired,
  isViewerDevice,
  issueViewerToken,
  loadOrCreateConfig,
  mergeDevicesByClient,
  saveConfig,
} from "./config.mjs";
import { deriveSessionKey, open as sealedOpen, seal } from "./crypto.mjs";
import { listClaudeCommands, searchFiles } from "./file-search.mjs";
import { readRolloutWindow, RolloutTail } from "./rollout-tail.mjs";

// 手机端鉴权时上报的设备短标签（如「iPhone · 微信」）净化后作 device.name 显示用：
// 去控制字符/换行、掐头空白、限长，避免污染配置或菜单显示。非字符串一律成空串。
function sanitizeDeviceName(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 40);
}

// 手机端上报的浏览器身份 id（clientId）：本 app 自己生成、存在手机 localStorage 里的随机 id，
// 只用于"同一浏览器归并成一台设备"，不参与鉴权。净化为 [A-Za-z0-9_-]、限长；太短的当无效
// （避免脏值误把不同设备归并到一起）。非字符串一律成空串。
function sanitizeClientId(s) {
  if (typeof s !== "string") return "";
  const t = s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return t.length >= 8 ? t : "";
}

// AskUserQuestion 回答是有限、纯文本的 question -> answer 映射。限制数量与长度，
// 既保护常驻 Claude stdin，也避免把任意深对象透传到 agent 上下文。
function sanitizeQuestionAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [question, answer] of Object.entries(value)) {
    if (Object.keys(out).length >= 8 || typeof question !== "string" || typeof answer !== "string") return null;
    const q = question.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 4000);
    const a = answer.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 4000);
    if (!q || !a) return null;
    out[q] = a;
  }
  return Object.keys(out).length ? out : null;
}

// 围观（只读）连接的方法白名单：默认拒绝，未列出的方法（含未来新增）一律 403。
// session.watch 另有 scope 校验、image.fetch 另有会话归属校验、session.more 另有频控。
const VIEWER_METHODS = new Set([
  "ping",
  "session.watch",
  "session.watch.renew",
  "session.unwatch",
  "session.more",
  "image.fetch",
  "share.react",
]);

// 观众端 session.more 最小间隔：链接在群里意味着观众不可信，
// 反复触发会迫使 daemon 重读重发大快照（读放大）。
// 观众读放大频控：session.more 与 session.watch 都会迫使 daemon 重读整份
// rollout（回放窗口/尾部快照），二者共用同一最小间隔
const VIEWER_READ_MIN_INTERVAL_MS = 2000;
const WATCH_LEASE_MIN_MS = 30_000;
const WATCH_LEASE_MAX_MS = 120_000;

// 喝彩表情枚举：无文字即无骂人、无审核、无注入面
const REACT_EMOJI = new Set(["👏", "🔥", "❤️", "😂", "🤯"]);

// 把 app-server 审批请求里的 fileChanges 压缩成 [{path,kind,diff}]。
// 兼容两种序列化（{type:"update",unified_diff} / {update:{unified_diff}}）；
// 总量限预算，保证整帧远小于 relay 的 256KiB 上限。
function summarizeFileChanges(fileChanges) {
  if (!fileChanges || typeof fileChanges !== "object") return null;
  const files = [];
  let budget = 24_000;
  for (const [path, change] of Object.entries(fileChanges).slice(0, 20)) {
    let kind = "update";
    let diff = "";
    if (change?.type) {
      kind = change.type;
      diff = change.unified_diff ?? change.content ?? "";
    } else if (change?.update) {
      diff = change.update.unified_diff ?? "";
    } else if (change?.add) {
      kind = "add";
      diff = change.add.content ?? "";
    } else if (change?.delete) {
      kind = "delete";
    }
    diff = String(diff).slice(0, Math.max(0, Math.min(4000, budget)));
    budget -= diff.length;
    files.push({ path, kind, diff });
  }
  return files.length ? files : null;
}

// —— 会话内图片 ——
// 图片以裸 base64 内嵌在 rollout 条目里（生成图的 result、用户贴图的 data URL），
// 单条必超 48KB 截断上限。发送前抽出缓存、替换为 imageRef 引用，手机端经
// image.fetch 分块拉取。id 是内容哈希：同一图片重复出现不重复占内存。
// sessions 记录图片的来源会话集合：缓存按内容哈希去重，同一张图可能出现在
// 多个会话，观众取图时校验其 scope 在集合内（全权设备不受限）。
const imageCache = new Map(); // id -> { data: b64, mime, sessions: Set<sessionId> }
let imageCacheChars = 0;
const IMAGE_CACHE_BUDGET = 32 * 1024 * 1024; // base64 字符数预算（≈24MB 原始字节）
const IMAGE_MAX_CHARS = 12 * 1024 * 1024;
// 单块 b64 字符数（image.fetch 应答与 image.chunk 推送共用）：
// 最坏帧 ≈ 144k×0.75(deflate 回收 base64 膨胀)×1.33(信封 base64) + 信封开销 ≈ 193KB，
// 稳在 relay 256KiB 帧上限内
const IMAGE_CHUNK_CHARS = 144_000;

function sniffImageMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function cacheImage(b64, mime, sessionId) {
  if (typeof b64 !== "string" || b64.length > IMAGE_MAX_CHARS) return null;
  const id = createHash("sha256")
    .update(b64.slice(0, 64)).update(b64.slice(-64)).update(String(b64.length))
    .digest("base64url").slice(0, 16);
  const existing = imageCache.get(id);
  if (existing) {
    imageCache.delete(id); // LRU：重插到队尾
    imageCache.set(id, existing);
    if (sessionId) existing.sessions.add(sessionId);
  } else {
    imageCache.set(id, { data: b64, mime, sessions: new Set(sessionId ? [sessionId] : []) });
    imageCacheChars += b64.length;
    for (const [key, value] of imageCache) {
      if (imageCacheChars <= IMAGE_CACHE_BUDGET) break;
      imageCache.delete(key);
      imageCacheChars -= value.data.length;
    }
  }
  return { id, mime, size: Math.floor(b64.length * 0.75) };
}

// 手机端按轮 override 白名单：只放行已知字段与取值，不让远端注入任意 turn/start 参数。
// 字段形状与桌面端一致：sandboxPolicy 是 {type} 对象，approvalPolicy 是策略枚举。
const SANDBOX_TYPES = new Set(["readOnly", "workspaceWrite", "dangerFullAccess"]);
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "on-failure", "never"]);

export function sanitizeTurnOptions(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  if (typeof raw.model === "string" && raw.model.length > 0 && raw.model.length <= 64) {
    out.model = raw.model;
  }
  if (typeof raw.effort === "string" && /^[a-z]{1,16}$/.test(raw.effort)) out.effort = raw.effort;
  if (APPROVAL_POLICIES.has(raw.approvalPolicy)) out.approvalPolicy = raw.approvalPolicy;
  if (SANDBOX_TYPES.has(raw.sandboxPolicy?.type)) out.sandboxPolicy = { type: raw.sandboxPolicy.type };
  if (raw.plan === true) out.plan = true; // hub 展开为 collaborationMode {mode:"plan"}
  return Object.keys(out).length ? out : undefined;
}

export function extractImages(item, sessionId) {
  const p = item?.payload;
  if (!p) return item;
  if (p.type === "image_generation_call" && typeof p.result === "string" && p.result.length > 4096) {
    const ref = cacheImage(p.result, sniffImageMime(p.result), sessionId);
    return { ...item, payload: { ...p, result: null, imageRef: ref ?? { tooLarge: true } } };
  }
  if (p.type === "message" && Array.isArray(p.content)) {
    let changed = false;
    const content = p.content.map((c) => {
      if (typeof c?.image_url !== "string" || !c.image_url.startsWith("data:image/")) return c;
      const comma = c.image_url.indexOf(",");
      const b64 = c.image_url.slice(comma + 1);
      if (comma < 0 || b64.length <= 4096) return c;
      const mime = c.image_url.slice(5, c.image_url.indexOf(";"));
      changed = true;
      const ref = cacheImage(b64, mime, sessionId);
      return { ...c, image_url: null, imageRef: ref ?? { tooLarge: true } };
    });
    if (changed) return { ...item, payload: { ...p, content } };
  }
  return item;
}

// 收集条目里的 imageRef id（extractImages 之后的形状：payload.imageRef 或 content[].imageRef）
function collectImageRefs(entry, out) {
  const p = entry?.payload;
  if (!p) return;
  if (p.imageRef?.id) out.add(p.imageRef.id);
  if (Array.isArray(p.content)) {
    for (const c of p.content) if (c?.imageRef?.id) out.add(c.imageRef.id);
  }
}

export class ClientSession {
  #cid;
  #daemon; // { config, configPath, privateKey, appServer, hub, log }
  #send; // (data) => void  发送 E2E 信封给该 client
  #close; // () => void     要求 relay 断开该 client
  #getBuffered; // () => number  本连接传输层的未冲刷字节数（背压水位）
  #key = null;
  #clientDeflate = false; // 对端首帧 zc:1 时置真：其能 inflate，故大帧 d2c 可 deflate 压缩
  // 信封序号（防中继重放）：对端在 auth 参数里声明 caps.seq:1 后启用——协商走加密信道，
  // 中继剥不掉（放明文信封字段会被恶意中继静默降级）。启用后 d2c 每帧带单调递增 s 并
  // 绑进 AAD；c2d 一旦见过带 s 的帧就要求此后每帧都带且严格递增（缺失/回退=重放，断开）
  #seqCap = false;
  #sendSeq = 0;
  #recvSeq = 0;
  // 图片推送（caps.img:1）：快照/tail 条目里出现
  // imageRef 时 daemon 主动分块推流（image.chunk），砍掉客户端逐块 image.fetch 的串行往返。
  // 观众不推（其通知帧走低优先级 outbox，大图会挤爆它触发无谓的重快照），仍走拉取。
  #imgPushCap = false;
  #pushedImages = new Set(); // 本连接已推送过的图片 id（生成图多帧进度/重看同图去重）
  #disposed = false;
  #device = null;
  #tail = null;
  #watchedThreadId = null;
  #watchedAgent = "codex"; // 当前 watch 的会话属于哪个 agent（unwatch 时定位正确的 hub）
  // watch 代次号：onEnvelope 不串行（每帧处理在 await 处交错），快速切会话时
  // 慢的旧 #watch 可能在新 watch 之后才恢复执行、把状态改回旧会话（客户端按
  // currentId 过滤后表现为"新会话不再更新"），或 session.more 读旧文件却用新
  // sessionId 发帧（跨会话串数据）。每个 await 之后校验代次，作废即放弃。
  #watchGen = 0;
  #watchToken = null; // 客户端本次 watch 自带的不透明串，原样打在快照/事件帧上（见 #watch）
  #watchLeaseTimer = null; // 网页后台被冻结、unwatch 发不出时，租约到期自动停 tail/live 推流
  #watchLeaseMs = 0;
  // 回放模式（观众看已结束的会话，从头读）：记文件路径与已下发条目数
  #replayPath = null;
  #replayOffset = 0;
  // 回放帧被 outbox 溢出丢弃时的最低条目偏移：drain 排空后从这里补读续传
  // （#enqueue 在此非空时并入丢弃后续回放帧，保证被丢条目连续、追加补齐即无重无漏）
  #replayLow = null;
  #moreBusy = false; // 回放 session.more 单飞：并发的第二发会从同一偏移重读、条目翻倍
  #enqueueReplayFrom = null; // #sendItems 入队时给帧打回放偏移标（瞬时游标）
  #resendingReplay = false; // 补发单飞闸（见 #resendReplay）
  // 手机上传的附图缓冲（image.push 分块，session.send 引用后即弃）
  #uploads = new Map(); // id -> { mime, parts: [], chars, done }
  #uploadChars = 0;
  static #UPLOAD_BUDGET = 24 * 1024 * 1024; // 单连接缓冲上限（base64 字符）
  // 观众连接的低优先级发送队列（控制通道优先：审批与全权设备帧永远直发，
  // 上行饱和时延迟/丢弃观众帧，观众端经尾部快照追平）
  #outbox = []; // [{ message, size }]
  #outboxChars = 0;
  #drainTimer = null;
  #needsResnapshot = false;
  #congestedSince = 0; // 观众帧开始积压的时刻；0 = 未拥塞
  #lastMoreAt = 0; // session.more 频控（仅观众）
  #lastWatchAt = 0; // session.watch 频控（仅观众；fromStart 每次都是整文件读）
  // share.react 令牌桶：突发 5、平均 2/s（连点狂按被吸收，刷子被拒）
  #reactTokens = 5;
  #reactRefillAt = Date.now();
  static #OUTBOX_MAX_FRAMES = 200;
  static #OUTBOX_MAX_CHARS = 2 * 1024 * 1024;
  static #SEND_HIGH_WATER = 1 << 20; // relay WebSocket bufferedAmount 高水位

  constructor(cid, daemon, { send, close, getBufferedAmount }) {
    this.#cid = cid;
    this.#daemon = daemon;
    this.#send = send;
    this.#close = close;
    // 背压水位按传输层区分：直连（RTC DataChannel）连接看自己通道的缓冲，
    // 中继连接共享 relay 上行 ws 的缓冲（历史行为，缺省回落）
    this.#getBuffered = getBufferedAmount ?? (() => this.#daemon.getBufferedAmount?.() ?? 0);
  }

  // —— 供 hub/main 读取的连接身份（#device 保持私有）——
  get deviceId() {
    return this.#device?.deviceId ?? null;
  }

  get isViewer() {
    return isViewerDevice(this.#device);
  }

  get scopeSessionId() {
    return this.#device?.scope?.sessionId ?? null;
  }

  get scopeAgent() {
    return this.#device?.scope?.agent ?? "codex";
  }

  // 观众帧持续积压的起始时刻（拥塞提示用）；未拥塞为 0
  get congestedSince() {
    return this.#congestedSince;
  }

  // 撤销/过期时由 daemon 主动断开该连接；对端重连后鉴权得 403 进入终态
  kick() {
    this.#close();
  }

  // —— agent 路由 ——
  // 手机端首页下拉切换 agent；每个会话相关请求带 agent 字段（缺省 codex，向后兼容）。
  // 未注册的 agent 一律回落到 codex，避免协议注入不存在的后端。
  #agentOf(params) {
    const a = params?.agent;
    return typeof a === "string" && this.#daemon.backends?.[a] ? a : "codex";
  }

  #backend(agent) {
    return this.#daemon.backends?.[agent] ?? this.#daemon.appServer;
  }

  #hub(agent) {
    return this.#daemon.hubs?.[agent] ?? this.#daemon.hub;
  }

  // 全部 hub 的唯一枚举点：兼容只有单 hub（daemon.hub）的旧形状，新增枚举场景一律经此
  #allHubs() {
    return this.#daemon.hubs ? Object.values(this.#daemon.hubs) : [this.#daemon.hub];
  }

  // 鉴权成功后注册到所有 agent 的 hub：审批/看板变更可能来自任一 agent，都要能推达本连接。
  // 观众（只读围观）只注册到链接所属 agent 的 hub，避免在其它 hub 里触发无意义的
  // 观众计数/广播。旧链接无 scope.agent 时按 codex 兼容。
  #registerAllHubs() {
    if (this.isViewer) {
      this.#hub(this.scopeAgent)?.registerClient(this);
      return;
    }
    for (const hub of this.#allHubs()) hub?.registerClient(this);
  }

  #removeAllHubs() {
    for (const hub of this.#allHubs()) hub?.removeClient(this);
  }

  // 收到该 client 的一帧信封
  async onEnvelope(envelope) {
    try {
      if (!this.#key) {
        if (envelope.v !== 1 || typeof envelope.k !== "string") {
          this.#close();
          return;
        }
        this.#key = deriveSessionKey(
          this.#daemon.privateKey,
          Buffer.from(envelope.k, "base64"),
          this.#daemon.config.daemonId,
        );
        // 首帧协商：对端声明能 inflate（zc:1）才对其 d2c 大帧压缩。老客户端不带此标记，
        // 恒发未压缩帧，向后兼容。zc 是能力广播，与逐帧压缩标记 z 分属两字段，互不冲突。
        this.#clientDeflate = envelope.zc === 1;
      }
      // 序号校验先于解密：带 s 必须严格递增；见过 s 之后缺 s 即重放旧帧，一律断开。
      // s 本身受 AAD 保护（crypto.open 按 s 构造 AAD），中继篡改/剥离会认证失败。
      if (envelope.s !== undefined) {
        if (!Number.isInteger(envelope.s) || envelope.s <= this.#recvSeq) {
          throw new Error(`信封序号非法或回退（疑似重放）: ${envelope.s}`);
        }
      } else if (this.#recvSeq > 0) {
        throw new Error("信封缺失序号（疑似重放）");
      }
      const message = sealedOpen(this.#key, "c2d", envelope);
      if (envelope.s !== undefined) this.#recvSeq = envelope.s;
      await this.#onMessage(message);
    } catch (err) {
      // 解密失败 = 非法对端，直接断开
      this.#daemon.log(`client ${this.#cid} 消息处理失败: ${err.message}`);
      this.#close();
    }
  }

  async #onMessage(message) {
    if (!this.#device) {
      if (message.method !== "auth") {
        this.#reply(message.id, null, { code: 401, message: "未鉴权" });
        this.#close();
        return;
      }
      await this.#auth(message);
      return;
    }
    // 只读围观连接：默认拒绝，白名单放行（未来新增方法天然被拒）
    if (this.isViewer && !VIEWER_METHODS.has(message.method)) {
      this.#reply(message.id, null, { code: 403, message: "只读围观连接无权执行该操作" });
      return;
    }
    switch (message.method) {
      case "ping":
        this.#notify("pong", {});
        return;
      case "rtc.offer": {
        // 局域网直连升级（PROTOCOL.md §3.9）：本连接充当信令通道——已过鉴权，
        // 未授权设备根本走不到这里。vanilla ICE 单次往返：offer 进、answer 出。
        // 直连通道建立后对端会重新握手+鉴权，这里不传递任何身份。
        // 观众连接被 VIEWER_METHODS 白名单挡在门外（直连仅全权设备）。
        if (!this.#daemon.rtc) {
          this.#reply(message.id, null, { code: 501, message: "直连未开启" });
          return;
        }
        try {
          this.#reply(message.id, await this.#daemon.rtc.handleOffer(this, message.params));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `直连协商失败: ${err.message}` });
        }
        return;
      }
      case "agents.list":
        // 手机端首页下拉数据源：已注册的可切换 agent（codex / claude）
        this.#reply(message.id, {
          agents: this.#daemon.availableAgents?.() ?? [{ id: "codex", name: "ChatGPT", healthy: true }],
        });
        return;
      case "sessions.list": {
        // 单页应答（~100 条 ≈ 65KiB，安全过 relay 256KiB 帧上限）+ nextCursor。
        // 客户端按游标翻页累计，覆盖全部项目；一次性发上千条会挤爆单帧导致卡死。
        const agent = this.#agentOf(message.params);
        const page = await this.#backend(agent).listThreadsPage({
          cursor: message.params?.cursor ?? null,
          limit: message.params?.limit,
          cwd: message.params?.cwd ?? null, // 给定则只拉该项目会话（首页展开项目用），恒定有界
        });
        const hub = this.#hub(agent);
        const now = Date.now();
        this.#reply(message.id, {
          sessions: page.items.map(({ path, preview, ...rest }) => ({
            ...rest,
            // 对标 ChatGPT 官方 App：列表行只显示标题，不再显示摘要。preview 每条上百字符、
            // 是帧里的大头——有正式名字时直接不回（每帧省一半以上，故每批可翻到 500 条）；
            // 仅无名会话回一小段（≤48）供客户端做兜底标题。完整内容始终走 watch/tail。
            preview: rest.name ? "" : preview ? String(preview).slice(0, 48) : "",
            // 看板状态：running=本 daemon 正在驱动；active=会话文件近 60s 有写入
            // （覆盖桌面 GUI 正在跑的会话）；approvals=待决审批数
            running: hub.isRunning(rest.id),
            active: path ? this.#isFileActive(path, now) : false,
            approvals: hub.approvalCount(rest.id),
          })),
          nextCursor: page.nextCursor,
          agent,
        });
        return;
      }
      case "projects.list": {
        // 首页「按项目」数据源：daemon 本地扫描分组（缓存），一帧回全部项目 + 一小撮需要
        // 关注的会话。与会话总量无关地只需 1 次往返；每个项目的会话由客户端展开时才懒加载。
        const agent = this.#agentOf(message.params);
        const backend = this.#backend(agent);
        const hub = this.#hub(agent);
        const { projects, idToCwd, hasMore } = await backend.aggregateProjects();
        // 运行/审批徽标实时从 hub 叠加（小集合，不进缓存、不 stat 文件）
        const runByCwd = new Map();
        const apprByCwd = new Map();
        for (const id of hub.runningThreadIds?.() ?? []) {
          const c = idToCwd.get(id);
          if (c) runByCwd.set(c, (runByCwd.get(c) || 0) + 1);
        }
        const apprByThread = hub.approvalsByThread?.() ?? new Map();
        for (const [id, n] of apprByThread) {
          const c = idToCwd.get(id);
          if (c) apprByCwd.set(c, (apprByCwd.get(c) || 0) + n);
        }
        const projOut = projects.map((p) => ({
          cwd: p.cwd,
          count: p.count,
          latestUpdatedAt: p.latestUpdatedAt,
          latestName: p.latestName,
          latestPreview: p.latestPreview,
          runningCount: runByCwd.get(p.norm) || 0,
          approvals: apprByCwd.get(p.norm) || 0,
        }));
        // attention：正在跑 / 待审批的会话（含尚未进缓存扫描的新会话）——用 readThread 逐个
        // 解析（集合极小，通常个位数），保证「需要关注的事」在首页一定完整可见。
        const attnIds = new Set([...(hub.runningThreadIds?.() ?? []), ...apprByThread.keys()]);
        const now = Date.now();
        const attention = [];
        for (const id of attnIds) {
          const th = await backend.readThread(id);
          if (!th || th.archived) continue;
          attention.push({
            id: th.id,
            cwd: th.cwd,
            name: th.name,
            preview: th.preview ? String(th.preview).slice(0, 80) : "",
            updatedAt: th.updatedAt,
            source: th.source,
            status: th.status,
            running: hub.isRunning(id),
            active: th.path ? this.#isFileActive(th.path, now) : false,
            approvals: hub.approvalCount(id),
          });
        }
        this.#reply(message.id, { projects: projOut, attention, hasMore, agent, generatedAt: now });
        return;
      }
      case "session.watch":
        await this.#watch(message);
        return;
      case "session.watch.renew": {
        const wt = typeof message.params?.wt === "string" ? message.params.wt : "";
        if (!this.#watchedThreadId || !this.#watchLeaseMs || !wt || wt !== this.#watchToken) {
          this.#reply(message.id, null, { code: 409, message: "watch 已失效，请重新订阅" });
          return;
        }
        this.#armWatchLease(this.#watchLeaseMs);
        this.#reply(message.id, { ok: true });
        return;
      }
      case "session.unwatch": {
        const wt = typeof message.params?.wt === "string" ? message.params.wt : "";
        // 后台 unwatch 可能跨 RTC/relay 切换后迟到；带 wt 的旧请求不得误停后来建立的新 watch。
        if (wt && wt !== this.#watchToken) {
          this.#reply(message.id, { ok: true, stale: true });
          return;
        }
        this.#watchGen++; // 使在途的旧 watch 作废（其 await 恢复后按代次放弃）
        this.#stopWatch();
        this.#reply(message.id, { ok: true });
        return;
      }
      case "session.more": {
        // 手机端「下拉加载更早」：按更大的 limit 重发一次尾部快照
        if (this.isViewer) {
          const now = Date.now();
          if (now - this.#lastMoreAt < VIEWER_READ_MIN_INTERVAL_MS) {
            this.#reply(message.id, null, { code: 429, message: "操作过于频繁，请稍候" });
            return;
          }
          this.#lastMoreAt = now;
        }
        const limit = Math.max(1, Math.min(5000, Number(message.params?.limit) || 200));
        // 回放模式：从上次位置继续向后读，以 session.event（追加）下发——
        // 与尾部模式的"重发更大快照"语义相反，读一个创造过程应从头往后读
        if (this.#replayPath) {
          // 单飞：客户端超时重发（daemon 读文件超 15s）会与在途的上一发并发，
          // 两发从同一 #replayOffset 读同一窗口 → 观众端条目翻倍渲染
          if (this.#moreBusy) {
            this.#reply(message.id, null, { code: 429, message: "上一页仍在加载，请稍候" });
            return;
          }
          // 快照代次与来源：读文件期间可能有并发 watch 切走会话，恢复后若用
          // 新的 #watchedThreadId 发旧文件的条目就是跨会话串数据，必须作废
          const gen = this.#watchGen;
          const sid = this.#watchedThreadId;
          const from = this.#replayOffset;
          this.#moreBusy = true;
          let items, total;
          try {
            ({ items, total } = await readRolloutWindow(this.#replayPath, from, limit));
          } finally {
            this.#moreBusy = false;
          }
          if (this.#watchSuperseded(gen, message.id)) return;
          this.#reply(message.id, {
            ok: true,
            mode: "replay",
            total,
            done: from + items.length >= total,
          });
          this.#sendItems(sid, items, { snapshot: false, replayFrom: from });
          this.#replayOffset = from + items.length;
          return;
        }
        if (!this.#tail) {
          this.#reply(message.id, null, { code: 409, message: "未在监听会话" });
          return;
        }
        this.#reply(message.id, { ok: true });
        await this.#tail.resnapshot(limit); // 触发一条新的 session.snapshot 推送
        return;
      }
      case "session.send": {
        const { sessionId, text, images } = message.params ?? {};
        const hasText = typeof text === "string" && text.trim();
        // 去重：重复 id 会在 #takeUploads 消费阶段第二次取到 undefined（首份已弃）
        const ids = Array.isArray(images) ? [...new Set(images.slice(0, 4))] : [];
        if (!sessionId || (!hasText && !ids.length)) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId 或消息内容" });
          return;
        }
        let imageUrls;
        try {
          imageUrls = this.#takeUploads(ids); // 引用已上传完的附图，转 data URL
        } catch (err) {
          this.#reply(message.id, null, { code: 400, message: err.message });
          return;
        }
        try {
          const options = sanitizeTurnOptions(message.params?.options);
          const res = await this.#hub(this.#agentOf(message.params)).sendMessage(
            sessionId,
            hasText ? text : "",
            imageUrls,
            options,
          );
          this.#reply(message.id, res);
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `发送失败: ${err.message}` });
        }
        return;
      }
      case "question.respond": {
        const { sessionId, toolUseId } = message.params ?? {};
        const answers = sanitizeQuestionAnswers(message.params?.answers);
        if (!sessionId || typeof toolUseId !== "string" || toolUseId.length > 256 || !answers) {
          this.#reply(message.id, null, { code: 400, message: "问答回复参数非法" });
          return;
        }
        try {
          const res = await this.#hub(this.#agentOf(message.params)).answerQuestion(sessionId, toolUseId, answers);
          this.#reply(message.id, res);
        } catch (err) {
          this.#reply(message.id, null, { code: 409, message: `问答回复失败: ${err.message}` });
        }
        return;
      }
      case "goal.set": {
        // 会话目标（官方 App 的 Pursue goal）：goal 为空串/缺省即清除
        const { sessionId, goal } = message.params ?? {};
        if (!sessionId || (goal !== undefined && typeof goal !== "string") || (goal?.length ?? 0) > 4000) {
          this.#reply(message.id, null, { code: 400, message: "goal.set 参数非法" });
          return;
        }
        try {
          this.#reply(message.id, await this.#hub(this.#agentOf(message.params)).setGoal(sessionId, goal?.trim() || null));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `设定目标失败: ${err.message}` });
        }
        return;
      }
      case "goal.get": {
        const { sessionId } = message.params ?? {};
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        this.#reply(message.id, await this.#hub(this.#agentOf(message.params)).getGoal(sessionId));
        return;
      }
      case "models.list": {
        // 代理后端的 model/list：手机端模型选择器数据源（瘦身：只留展示与选择所需）
        try {
          const r = await this.#backend(this.#agentOf(message.params)).request("model/list", {});
          const models = (r?.data ?? [])
            .filter((m) => !m.hidden)
            .map((m) => ({
              id: m.id ?? m.model,
              name: m.displayName ?? m.model ?? m.id,
              description: m.description ?? "",
              efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
              defaultEffort: m.defaultReasoningEffort ?? null,
              isDefault: m.isDefault === true,
            }));
          this.#reply(message.id, { models });
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `获取模型列表失败: ${err.message}` });
        }
        return;
      }
      case "image.push": {
        // 手机端发消息附图：分块上传（image.fetch 的镜像方向），eof 齐后待 session.send 引用
        const { id, mime, data, eof } = message.params ?? {};
        if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id) || typeof data !== "string") {
          this.#reply(message.id, null, { code: 400, message: "image.push 参数非法" });
          return;
        }
        let up = this.#uploads.get(id);
        if (!up) {
          up = { mime: typeof mime === "string" ? mime : "image/jpeg", parts: [], chars: 0, done: false };
          this.#uploads.set(id, up);
        }
        up.chars += data.length;
        this.#uploadChars += data.length;
        if (up.chars > IMAGE_MAX_CHARS || this.#uploadChars > ClientSession.#UPLOAD_BUDGET) {
          this.#dropUpload(id);
          this.#reply(message.id, null, { code: 413, message: "图片过大或上传缓冲已满" });
          return;
        }
        up.parts.push(data);
        if (eof) up.done = true;
        this.#reply(message.id, { ok: true });
        return;
      }
      case "files.search": {
        // 手机端 @ 文件补全：限定在允许的工作目录内做有界模糊查找（见 file-search.mjs）
        const { cwd, query } = message.params ?? {};
        if (typeof cwd !== "string" || !cwd) {
          this.#reply(message.id, null, { code: 400, message: "缺少 cwd" });
          return;
        }
        if (!this.#daemon.isCwdAllowed(cwd)) {
          this.#reply(message.id, null, { code: 403, message: "该目录不在允许列表中" });
          return;
        }
        const limit = Math.max(1, Math.min(50, Number(message.params?.limit) || 20));
        try {
          this.#reply(message.id, { files: await searchFiles(cwd, typeof query === "string" ? query : "", limit) });
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `文件查找失败: ${err.message}` });
        }
        return;
      }
      case "commands.list": {
        // 斜杠命令面板数据源：Claude 自定义命令（用户级 + 项目级）。cwd 可缺省（只回用户级）。
        const { cwd } = message.params ?? {};
        if (cwd !== undefined && typeof cwd !== "string") {
          this.#reply(message.id, null, { code: 400, message: "cwd 参数非法" });
          return;
        }
        const projectCwd = cwd && this.#daemon.isCwdAllowed(cwd) ? cwd : null;
        try {
          this.#reply(message.id, { commands: await listClaudeCommands(projectCwd) });
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `命令列表失败: ${err.message}` });
        }
        return;
      }
      case "turn.interrupt": {
        const { sessionId } = message.params ?? {};
        try {
          this.#reply(message.id, await this.#hub(this.#agentOf(message.params)).interrupt(sessionId));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: err.message });
        }
        return;
      }
      case "session.new": {
        const cwd = message.params?.cwd;
        if (cwd && !this.#daemon.isCwdAllowed(cwd)) {
          this.#reply(message.id, null, { code: 403, message: "该目录不在允许列表中" });
          return;
        }
        try {
          this.#reply(message.id, await this.#hub(this.#agentOf(message.params)).newThread(cwd));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `新建失败: ${err.message}` });
        }
        return;
      }
      case "session.start": {
        const { cwd, text, images } = message.params ?? {};
        if (cwd && !this.#daemon.isCwdAllowed(cwd)) {
          this.#reply(message.id, null, { code: 403, message: "该目录不在允许列表中" });
          return;
        }
        const hasText = typeof text === "string" && text.trim();
        const ids = Array.isArray(images) ? [...new Set(images.slice(0, 4))] : [];
        if (!hasText && !ids.length) {
          this.#reply(message.id, null, { code: 400, message: "缺少消息内容" });
          return;
        }
        let imageUrls;
        try {
          imageUrls = this.#takeUploads(ids);
        } catch (err) {
          this.#reply(message.id, null, { code: 400, message: err.message });
          return;
        }
        try {
          const options = sanitizeTurnOptions(message.params?.options);
          const agent = this.#agentOf(message.params);
          this.#reply(message.id, await this.#hub(agent).startSession(
            cwd,
            hasText ? text : "",
            imageUrls,
            options,
          ));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `新建并发送失败: ${err.message}` });
        }
        return;
      }
      case "session.fork": {
        const { sessionId } = message.params ?? {};
        const agent = this.#agentOf(message.params);
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        if (agent !== "codex") {
          this.#reply(message.id, null, { code: 400, message: "该后端暂不支持打分支" });
          return;
        }
        try {
          this.#reply(message.id, await this.#hub(agent).forkThread(sessionId));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `打分支失败: ${err.message}` });
        }
        return;
      }
      case "session.archive": {
        const { sessionId } = message.params ?? {};
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        try {
          this.#reply(message.id, await this.#hub(this.#agentOf(message.params)).archiveThread(sessionId));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `归档失败: ${err.message}` });
        }
        return;
      }
      case "session.unarchive": {
        const { sessionId } = message.params ?? {};
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        try {
          this.#reply(message.id, await this.#hub(this.#agentOf(message.params)).unarchiveThread(sessionId));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `取消归档失败: ${err.message}` });
        }
        return;
      }
      case "project.archive": {
        const { cwd } = message.params ?? {};
        if (typeof cwd !== "string" || !cwd.trim()) {
          this.#reply(message.id, null, { code: 400, message: "缺少 cwd" });
          return;
        }
        const agent = this.#agentOf(message.params);
        const backend = this.#backend(agent);
        const ids = [];
        const seen = new Set();
        let cursor = null;
        try {
          for (let guard = 0; guard < 120; guard++) {
            const page = await backend.listThreadsPage({ cwd, cursor, limit: 2000 });
            for (const s of page.items ?? []) {
              if (s?.id && !seen.has(s.id)) {
                seen.add(s.id);
                ids.push(s.id);
              }
            }
            cursor = page.nextCursor ?? null;
            if (!cursor) break;
          }
          let archived = 0;
          for (const sessionId of ids) {
            await this.#hub(agent).archiveThread(sessionId);
            archived++;
          }
          this.#reply(message.id, { ok: true, archived });
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `归档项目失败: ${err.message}` });
        }
        return;
      }
      case "image.fetch": {
        // 分块返回缓存图片：单块 ≤96k base64 字符，信封远小于 relay 256KiB 上限
        const { id, offset = 0 } = message.params ?? {};
        const img = imageCache.get(id);
        if (!img) {
          this.#reply(message.id, null, { code: 404, message: "图片不在缓存（电脑端可能重启过，重新打开会话可恢复）" });
          return;
        }
        // 观众只能取本会话抽出的图片（缓存按内容哈希跨会话去重，故校验来源集合）
        if (this.isViewer && !img.sessions.has(this.scopeSessionId)) {
          this.#reply(message.id, null, { code: 403, message: "该图片不属于本会话" });
          return;
        }
        const data = img.data.slice(offset, offset + IMAGE_CHUNK_CHARS);
        this.#reply(message.id, {
          data,
          mime: img.mime,
          size: img.data.length,
          eof: offset + IMAGE_CHUNK_CHARS >= img.data.length,
        });
        return;
      }
      case "approval.respond": {
        const { approvalKey, decision } = message.params ?? {};
        const allowed = ["accept", "acceptForSession", "decline", "cancel"];
        if (!allowed.includes(decision)) {
          this.#reply(message.id, null, { code: 400, message: "非法审批决定" });
          return;
        }
        // 审批 key 带 agent 前缀全局唯一（见 session-hub）：先按回填的 agent 路由；
        // 旧页面不回填时缺省 codex，未命中再跨 hub 兜底——错投至多"未命中"，不会批错
        let approvalRes = this.#hub(this.#agentOf(message.params)).respondApproval(approvalKey, decision);
        if (!approvalRes.ok) {
          for (const hub of this.#allHubs()) {
            const r = hub?.respondApproval(approvalKey, decision);
            if (r?.ok) {
              approvalRes = r;
              break;
            }
          }
        }
        this.#reply(message.id, approvalRes);
        return;
      }
      // —— 围观链接（仅全权设备：viewer 已被上方白名单挡住）——
      // 配置写路径一律"从盘 fresh-load → 改 → 存 → 回写内存"：deviceToken 鉴权
      // 每次都整体重读配置，直接改内存旧引用会被下一次鉴权覆盖丢失。
      case "share.create": {
        const { sessionId, ttl } = message.params ?? {};
        if (!sessionId || (ttl !== "24h" && ttl !== null && ttl !== undefined)) {
          this.#reply(message.id, null, { code: 400, message: "share.create 参数非法（ttl 仅支持 \"24h\" 或 null）" });
          return;
        }
        const agent = this.#agentOf(message.params);
        const thread = await this.#backend(agent).readThread(sessionId);
        if (!thread) {
          this.#reply(message.id, null, { code: 404, message: "会话不存在" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        const { device } = issueViewerToken(this.#daemon.configPath, fresh, {
          sessionId,
          sessionName: thread.name || "",
          ttlMs: ttl === "24h" ? 24 * 3600_000 : null,
          agent,
        });
        this.#daemon.config = fresh;
        this.#reply(message.id, { url: device.url, deviceId: device.deviceId });
        return;
      }
      case "share.revoke": {
        const { deviceId } = message.params ?? {};
        if (!deviceId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 deviceId" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        const target = (fresh.devices ?? []).find((d) => d.deviceId === deviceId);
        // 仅允许撤销围观条目：全权设备撤销走桌面设备页，协议面不扩权
        if (!target || !isViewerDevice(target)) {
          this.#reply(message.id, null, { code: 404, message: "围观链接不存在" });
          return;
        }
        fresh.devices = fresh.devices.filter((d) => d !== target);
        saveConfig(this.#daemon.configPath, fresh);
        this.#daemon.config = fresh;
        this.#hub(target.scope?.agent ?? "codex").finishLink?.(deviceId); // 围观战报（有访客才发），先交账再踢人
        this.#daemon.kickDevice?.(deviceId); // 撤销即全场踢（config-watch 是兜底）
        this.#reply(message.id, { ok: true });
        return;
      }
      case "share.react": {
        // 围观层互动：只进 daemon 的通知广播，绝不进会话与 agent 上下文
        const { emoji } = message.params ?? {};
        if (!REACT_EMOJI.has(emoji)) {
          this.#reply(message.id, null, { code: 400, message: "不支持的表情" });
          return;
        }
        const now = Date.now();
        this.#reactTokens = Math.min(5, this.#reactTokens + ((now - this.#reactRefillAt) / 1000) * 2);
        this.#reactRefillAt = now;
        if (this.#reactTokens < 1) {
          this.#reply(message.id, null, { code: 429, message: "喝彩太快了，歇一下" });
          return;
        }
        this.#reactTokens -= 1;
        const sessionId = this.isViewer ? this.scopeSessionId : message.params?.sessionId;
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        // 创作者按链接静音全部互动：muted 按 deviceId 查当前配置（#device 可能是旧引用）
        if (this.isViewer) {
          const entry = (this.#daemon.config.devices ?? []).find((d) => d.deviceId === this.deviceId);
          if (entry?.muted === true) {
            this.#reply(message.id, { ok: true }); // 静默丢弃：不计数、不广播、不提示
            return;
          }
        }
        const agent = this.isViewer ? this.scopeAgent : this.#agentOf(message.params);
        this.#hub(agent).addReaction(sessionId, emoji, this.isViewer ? this.deviceId : null);
        this.#reply(message.id, { ok: true });
        return;
      }
      case "share.mute": {
        // 仅全权（viewer 被白名单挡住）：按链接静音全部互动，防打扰是底线
        const { deviceId, muted } = message.params ?? {};
        if (!deviceId || typeof muted !== "boolean") {
          this.#reply(message.id, null, { code: 400, message: "share.mute 参数非法" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        const target = (fresh.devices ?? []).find((d) => d.deviceId === deviceId);
        if (!target || !isViewerDevice(target)) {
          this.#reply(message.id, null, { code: 404, message: "围观链接不存在" });
          return;
        }
        target.muted = muted;
        saveConfig(this.#daemon.configPath, fresh);
        this.#daemon.config = fresh;
        this.#reply(message.id, { ok: true });
        return;
      }
      case "share.list": {
        // 分享弹窗数据源：该会话已存在的围观链接（决策 5：先展示、显式再生成）
        const { sessionId } = message.params ?? {};
        if (!sessionId) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId" });
          return;
        }
        const fresh = loadOrCreateConfig(this.#daemon.configPath);
        this.#daemon.config = fresh;
        const agent = this.#agentOf(message.params);
        const links = (fresh.devices ?? [])
          .filter((d) =>
            isViewerDevice(d) &&
            d.scope?.sessionId === sessionId &&
            (d.scope?.agent ?? "codex") === agent &&
            !isDeviceExpired(d))
          .map((d) => ({
            deviceId: d.deviceId,
            url: d.url ?? null,
            createdAt: d.createdAt,
            expiresAt: d.expiresAt ?? null,
            muted: d.muted === true,
            viewers: this.#hub(agent).viewerCountByDevice?.(d.deviceId) ?? 0,
          }));
        this.#reply(message.id, { links });
        return;
      }
      default:
        this.#reply(message.id, null, { code: 400, message: `未知方法: ${message.method}` });
    }
  }

  // daemon 能力回执（auth 应答）：img=图片推送流；rtc=局域网直连；wl=后台 watch 租约。
  // 客户端据 rtc 决定是否发起直连协商——不广播的话旧 daemon 会收到打不着的 rtc.offer
  #daemonCaps() {
    const caps = { img: 1, wl: 1 };
    if (this.#daemon.rtc) caps.rtc = 1;
    return caps;
  }

  async #auth(message) {
    const params = message.params ?? {};
    // 信封序号能力在加密的 auth 参数里协商（caps.seq:1）：中继看不见也剥不掉。
    // 在发出任何应答之前置位——auth 应答就是第一个带序号的 d2c 帧。旧客户端无 caps，恒走旧格式。
    this.#seqCap = params.caps?.seq === 1;
    this.#imgPushCap = params.caps?.img === 1;
    if (params.pairToken) {
      const paired = consumePairToken(this.#daemon.configPath, params.pairToken);
      if (!paired) {
        this.#reply(message.id, null, { code: 403, message: "配对码无效或已过期" });
        this.#close();
        return;
      }
      this.#daemon.config = paired.config;
      this.#device = paired.device;
      // 一次性配对即连接：写入 lastSeenAt，使设备页「最近连接」反映刚连过（createDevice 建时留空）
      paired.device.lastSeenAt = Date.now();
      // 手机上报的 UA 短标签作可读设备名（如「iPhone · 微信」）
      const pairName = sanitizeDeviceName(params.name);
      if (pairName) paired.device.name = pairName;
      // 同一浏览器归并：作废该浏览器名下的旧凭据，只留这条（详见 mergeDevicesByClient）
      const pairCid = sanitizeClientId(params.clientId);
      let pairMerged = [];
      if (pairCid) {
        paired.device.clientId = pairCid;
        pairMerged = mergeDevicesByClient(this.#daemon.config, paired.device.deviceId, pairCid);
      }
      saveConfig(this.#daemon.configPath, this.#daemon.config);
      this.#reply(message.id, {
        deviceId: paired.device.deviceId,
        deviceToken: paired.deviceToken,
        daemonName: paired.config.daemonName,
        protocol: APP_PROTOCOL,
        engine: this.#daemon.appServer.healthy ? "ok" : "down",
        caps: this.#daemonCaps(), // 能力回执：客户端据此等待图片推送（img）、发起直连升级（rtc）
      });
      this.#registerAllHubs();
      for (const id of pairMerged) this.#daemon.kickDevice?.(id); // 旧凭据若还连着，一并踢下线
      this.#daemon.log(`新设备配对成功: ${paired.device.deviceId}`);
      return;
    }
    if (params.deviceToken) {
      // 重读配置，保证撤销立即生效
      this.#daemon.config = loadOrCreateConfig(this.#daemon.configPath);
      const device = findDeviceByToken(this.#daemon.config, params.deviceToken);
      if (!device) {
        this.#reply(message.id, null, { code: 403, message: "设备令牌无效（可能已被撤销）" });
        this.#close();
        return;
      }
      const viewer = isViewerDevice(device);
      let devMerged = []; // 全权设备按 clientId 归并后被作废的旧条目（分支外踢下线用）
      if (isDeviceExpired(device)) {
        this.#reply(message.id, null, {
          code: 403,
          message: viewer ? "围观链接已过期" : "设备令牌已过期",
        });
        this.#close();
        return;
      }
      if (viewer) {
        // 熔断背板（非产品限制）：仅防病态场景（脚本海量建连打爆内存），
        // 按 scope.sessionId 跨该会话全部围观链接聚合计数，正常传播碰不到。
        const limit = this.#daemon.config.viewerLimit ?? 100;
        if (this.#hub(device.scope?.agent ?? "codex").viewerCount(device.scope?.sessionId) >= limit) {
          this.#reply(message.id, null, {
            code: 403,
            message: `围观人数已达上限（${limit}），为保护分享者的电脑暂不接待新观众`,
          });
          this.#close();
          return;
        }
        // 围观链接是共享条目：不用观众 UA 改写条目名（会被 N 个观众反复变脸）；
        // lastSeenAt 写盘节流——观众每次进出都写配置文件没有必要
        if (!device.lastSeenAt || Date.now() - device.lastSeenAt > 10 * 60_000) {
          device.lastSeenAt = Date.now();
          saveConfig(this.#daemon.configPath, this.#daemon.config);
        }
      } else {
        device.lastSeenAt = Date.now();
        // 永久链接设备建时无名；每次连接用手机上报的 UA 短标签刷新可读名
        const devName = sanitizeDeviceName(params.name);
        if (devName) device.name = devName;
        // 同一浏览器归并：作废该浏览器名下的旧凭据，只留这条
        const devCid = sanitizeClientId(params.clientId);
        if (devCid) {
          device.clientId = devCid;
          devMerged = mergeDevicesByClient(this.#daemon.config, device.deviceId, devCid);
        }
        saveConfig(this.#daemon.configPath, this.#daemon.config);
      }
      this.#device = device;
      this.#reply(message.id, {
        deviceId: device.deviceId,
        deviceToken: params.deviceToken,
        daemonName: this.#daemon.config.daemonName,
        protocol: APP_PROTOCOL,
        engine: this.#daemon.appServer.healthy ? "ok" : "down",
        // 观众端据此跳过看板直进会话只读视图。观众不回执 caps.img——观众连接
        // 不推图（见 #imgPushCap 注释），回执了会让观众端白等推送才回落拉取
        ...(viewer
          ? {
              role: "viewer",
              scope: { sessionId: device.scope?.sessionId ?? null, agent: device.scope?.agent ?? "codex" },
              sessionName: device.sessionName ?? "",
              caps: { wl: 1 }, // 观众不推图，但同样需要后台 watch 租约
            }
          : { caps: this.#daemonCaps() }), // 能力回执：图片推送（img）、直连升级（rtc）、watch 租约（wl）
      });
      this.#registerAllHubs();
      for (const id of devMerged) this.#daemon.kickDevice?.(id); // 同浏览器旧凭据若还连着，踢下线
      if (devMerged.length) this.#daemon.log(`归并同浏览器旧设备 ${devMerged.length} 条`);
      return;
    }
    this.#reply(message.id, null, { code: 400, message: "缺少配对码或设备令牌" });
    this.#close();
  }

  // 每个 await 恢复后必须调用：被更新的 watch/unwatch 顶替时回 409 并放弃。
  // 拒绝与应答绑在一起——散落的裸检查容易漏掉 #reply，让客户端白等 15s 超时。
  #watchSuperseded(gen, replyId) {
    if (gen === this.#watchGen) return false;
    this.#reply(replyId, null, { code: 409, message: "watch 已被更新的请求取代" });
    return true;
  }

  async #watch(message) {
    const sessionId = message.params?.sessionId;
    if (this.isViewer && sessionId !== this.scopeSessionId) {
      this.#reply(message.id, null, { code: 403, message: "该链接仅可围观指定会话" });
      return;
    }
    // 频控与 session.more 同源：watch（尤其 fromStart）每次都触发整文件读 +
    // 大快照重加密，链接是会转发给陌生人的，不能留无限读放大入口
    if (this.isViewer) {
      const now = Date.now();
      if (now - this.#lastWatchAt < VIEWER_READ_MIN_INTERVAL_MS) {
        this.#reply(message.id, null, { code: 429, message: "操作过于频繁，请稍候" });
        return;
      }
      this.#lastWatchAt = now;
    }
    const agent = this.isViewer ? this.scopeAgent : this.#agentOf(message.params);
    const gen = ++this.#watchGen; // 领号：任何更新的 watch/unwatch/dispose 都会使本次作废
    // watch 令牌：客户端每次 watch 自带的不透明串，daemon 原样打在本次 watch 产出的
    // 快照/事件帧上。快速重开同一会话时，被顶替的旧 watch 在途帧与新帧 sessionId 相同，
    // 客户端仅凭 sessionId 区分不开——凭 wt 丢弃旧帧，append 快照才不会双份追加
    const wt = typeof message.params?.wt === "string" && message.params.wt.length <= 64
      ? message.params.wt
      : null;
    let thread = await this.#backend(agent).readThread(sessionId);
    if (this.#watchSuperseded(gen, message.id)) return;
    // 新建会话竞态：session.start 应答后引擎的 rollout 文件可能尚未落盘，紧跟着的
    // watch 读到"无 path"——局域网直连把往返压到毫秒级后这几乎必现（手机端表现为
    // "Couldn't attach: 会话不存在"，而任务其实在跑）。仅对本 daemon 正在驱动或
    // 亲手建/resume 过的会话轮询等文件出现（最长 5s）；陌生 id 不享受等待，照旧
    // 秒回 404（观众/乱猜的 id 不给读放大面）。
    if (!thread?.path && !this.isViewer) {
      const hub = this.#hub(agent);
      if (hub.isRunning(sessionId) || hub.hasResumed?.(sessionId)) {
        for (let i = 0; i < 20 && !thread?.path; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (this.#watchSuperseded(gen, message.id)) return;
          thread = await this.#backend(agent).readThread(sessionId);
          if (this.#watchSuperseded(gen, message.id)) return;
        }
      }
    }
    if (!thread?.path) {
      this.#reply(message.id, null, { code: 404, message: "会话不存在" });
      return;
    }
    this.#stopWatch();
    this.#watchedThreadId = sessionId;
    this.#watchedAgent = agent;
    this.#watchToken = wt;
    // 历史与增量走会话文件 tail；实时流式事件（发消息后的增量输出、审批）走后端
    // 事件，由对应 agent 的 hub 推送。二者互补。
    this.#hub(agent).subscribe(sessionId, this);
    // 回放模式（fromStart）：分享跑完的会话是主场景，读一个创造过程应从头
    // 往后读。仅对已结束的会话生效——在跑（或文件近 60s 活跃，覆盖桌面 GUI
    // 驱动）时忽略之，回落尾部实时模式。已知边界：回放中会话复活不自动转直播。
    const running =
      this.#hub(agent).isRunning(sessionId) || this.#isFileActive(thread.path, Date.now());
    if (message.params?.fromStart && !running) {
      this.#replayPath = thread.path;
      const { items, total } = await readRolloutWindow(thread.path, 0, 500);
      if (this.#watchSuperseded(gen, message.id)) return; // 读文件期间已被新 watch 接管
      this.#armWatchLease(message.params?.leaseMs);
      this.#reply(message.id, { ok: true, mode: "replay", total });
      this.#sendItems(sessionId, items, { snapshot: true, total, replayFrom: 0 });
      this.#replayOffset = items.length;
      return;
    }
    // 断点续传：客户端带 have:{total,ident} 声明
    // 已持有 [0,total) 的尾部窗口。参数走加密信道（无需 caps 协商——旧 daemon 忽略未知
    // 参数、自然回落全量快照；命中与否由快照的 append 标志告知客户端）。
    const h = message.params?.have;
    const resume = h && Number.isInteger(h.total) && h.total > 0 && h.total <= 1_000_000
      && typeof h.ident === "string" && h.ident.length <= 64
      ? { total: h.total, ident: h.ident }
      : null;
    this.#tail = new RolloutTail(thread.path, {
      resume,
      onItems: (items, meta) => this.#sendItems(sessionId, items, meta),
      onError: (err) => this.#daemon.log(`tail ${sessionId} 失败: ${err.message}`),
    });
    this.#armWatchLease(message.params?.leaseMs);
    this.#reply(message.id, { ok: true, mode: "tail" });
    await this.#tail.start();
  }

  #stopWatch() {
    if (this.#watchLeaseTimer) clearTimeout(this.#watchLeaseTimer);
    this.#watchLeaseTimer = null;
    this.#watchLeaseMs = 0;
    this.#tail?.close();
    this.#tail = null;
    this.#replayPath = null;
    this.#replayOffset = 0;
    this.#replayLow = null;
    if (this.#watchedThreadId) {
      this.#hub(this.#watchedAgent).unsubscribe(this.#watchedThreadId, this);
      this.#watchedThreadId = null;
    }
    this.#watchToken = null;
  }

  #armWatchLease(value) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return;
    this.#watchLeaseMs = Math.max(WATCH_LEASE_MIN_MS, Math.min(WATCH_LEASE_MAX_MS, Math.trunc(requested)));
    if (this.#watchLeaseTimer) clearTimeout(this.#watchLeaseTimer);
    this.#watchLeaseTimer = setTimeout(() => {
      this.#watchLeaseTimer = null;
      const sid = this.#watchedThreadId;
      if (!sid) return;
      this.#watchGen++;
      this.#stopWatch();
      this.#daemon.log(`client ${this.#cid} 的 watch 租约到期，已停止会话 ${sid} 推流`);
    }, this.#watchLeaseMs);
    this.#watchLeaseTimer.unref?.();
  }

  #isFileActive(path, now) {
    try {
      return now - statSync(path).mtimeMs < 60_000;
    } catch {
      return false;
    }
  }

  // —— 附图上传缓冲 ——
  #dropUpload(id) {
    const up = this.#uploads.get(id);
    if (!up) return;
    this.#uploadChars -= up.chars;
    this.#uploads.delete(id);
  }

  // 取出已上传完的附图并转为 data URL（turn/start 的 {type:"image",url} 输入项）。
  // 先全量校验再统一消费：中途抛错不能把前面的图先弃掉，否则用户重试要全部重传。
  #takeUploads(ids) {
    for (const id of ids) {
      if (!this.#uploads.get(id)?.done) throw new Error("图片尚未完成上传，请重试");
    }
    return ids.map((id) => {
      const up = this.#uploads.get(id);
      const url = `data:${up.mime};base64,${up.parts.join("")}`;
      this.#dropUpload(id);
      return url;
    });
  }

  // —— hub 推送入口 ——
  pushLiveEvent(sessionId, method, params) {
    this.#sendLiveEvent(sessionId, method, params);
  }

  #sendLiveEvent(sessionId, method, params) {
    const payload = { sessionId, event: method, params };
    if (this.#watchToken) payload.wt = this.#watchToken;
    this.#notify("session.live", payload);
  }

  pushApproval(approvalKey, sessionId, method, params, agent = "codex") {
    this.#notify("approval.request", {
      approvalKey,
      sessionId,
      agent, // 手机端把此 agent 原样回填到 approval.respond，路由到正确的 hub（避免跨 hub key 撞号）
      kind: /fileChange|Patch/i.test(method) ? "fileChange" : "command",
      command: params?.command ?? null,
      cwd: params?.cwd ?? null,
      reason: params?.reason ?? null,
      // 文件修改审批：附文件清单与截断 diff，手机上才有足够上下文做决定
      files: summarizeFileChanges(params?.fileChanges ?? params?.changes),
    });
  }

  pushApprovalResolved(approvalKey, agent = "codex") {
    this.#notify("approval.resolved", { approvalKey, agent });
  }

  pushEngineState(healthy) {
    this.#notify("daemon.status", { engine: healthy ? "ok" : "down" });
  }

  pushBoardChanged(payload) {
    this.#notify("board.changed", payload);
  }

  // —— 围观层（喝彩/人数/战报）：观众收到的走 outbox 低优先级，天然不挤审批 ——
  pushShareReaction(payload) {
    this.#notify("share.reaction", payload);
  }

  pushViewerCount(payload) {
    this.#notify("viewer.count", payload);
  }

  pushShareSummary(payload) {
    this.#notify("share.summary", payload);
  }

  // 分块发送，保证每帧不超过 relay 的 256KiB 上限：
  // 首块用 session.snapshot（客户端清屏），后续块一律 session.event（追加）
  #sendItems(sessionId, items, meta) {
    const snapshot = meta.snapshot;
    const total = meta.total;
    // 回放帧带条目偏移入队：outbox 溢出丢弃时才知道该从哪补读（游标随分片推进）
    let replayCursor = typeof meta.replayFrom === "number" ? meta.replayFrom : null;
    const MAX_CHUNK_CHARS = 64_000;
    const MAX_ITEM_CHARS = 48_000;
    let chunk = [];
    let size = 0;
    let first = snapshot;
    let last = false; // 快照末分片标记（见 flush 内 end 注释）
    // 本批条目引用的图片：支持推送的客户端由 daemon 主动推流（image.chunk），
    // 砍掉逐块 image.fetch 的串行往返（N 块 = N 个来回 → 0 个来回）
    const imgIds = this.#imgPushCap && !this.isViewer ? new Set() : null;
    const flush = () => {
      if (chunk.length === 0 && !first) return;
      const payload = { sessionId, items: chunk };
      // watch 令牌原样回打：客户端凭它丢弃被顶替的旧 watch 在途帧
      if (this.#watchToken) payload.wt = this.#watchToken;
      if (first) {
        // total/ident 只随快照的首个分片下发（total 判断还有没有更早历史；
        // ident 是断点续传的文件指纹，客户端存起来、下次 watch 原样回传）
        if (total !== undefined) payload.total = total;
        if (meta.ident) payload.ident = meta.ident;
        if (meta.append) payload.append = true; // 续传补缺快照：客户端不清屏，直接续在末尾
      } else if (snapshot) {
        // 快照续块（同一快照的后续分片，走 session.event 通道）：客户端据此
        // 不把它计入 live 增量（token 统计）、也不推进续传的 total 游标
        payload.cont = true;
      }
      // 快照结束标记：客户端把 total/ident 暂存，收到 end 才提交为续传凭据——
      // 中途断线丢分片时凭据不落地，下次 watch 自然回落全量，缺洞不会固化
      if (snapshot && last) payload.end = true;
      this.#enqueueReplayFrom = replayCursor;
      this.#notify(first ? "session.snapshot" : "session.event", payload);
      this.#enqueueReplayFrom = null;
      if (replayCursor !== null) replayCursor += chunk.length;
      first = false;
      chunk = [];
      size = 0;
    };
    for (const item of items) {
      let entry = extractImages(item, sessionId); // 大图抽出缓存（记来源会话），条目瘦身后再做截断判断
      if (imgIds) collectImageRefs(entry, imgIds);
      let serialized = JSON.stringify(entry);
      if (serialized.length > MAX_ITEM_CHARS) {
        entry = {
          timestamp: item.timestamp,
          type: item.type,
          payload: { type: item.payload?.type ?? item.type, truncated: true },
        };
        serialized = JSON.stringify(entry);
      }
      if (size + serialized.length > MAX_CHUNK_CHARS && chunk.length > 0) flush();
      chunk.push(entry);
      size += serialized.length;
    }
    last = true;
    flush();
    // 条目帧全部入列后再推图：客户端先见到 imageRef 占位、随即收到内容块
    if (imgIds?.size) this.#pushImages([...imgIds]).catch(() => {});
  }

  // 图片推送流（Phase 1c）：把缓存图按块以通知帧推给客户端。
  // 高水位背压与 #resendReplay 同款——多帧大图不冲垮 relay 上行缓冲。
  // 并发安全：同 id 由 #pushedImages 先占位去重；不同 id 的块交错到达无妨，
  // 客户端按 (id, offset) 各自拼装。切会话（watch 代次变更）即中止：
  // 慢上行时旧会话的图块不该排在新会话首屏快照前面；被中止的 id 移出
  // 去重集，用户切回来时整图重推（客户端按 offset:0 重开拼装缓冲）。
  async #pushImages(ids) {
    const gen = this.#watchGen;
    for (const id of ids) {
      if (this.#pushedImages.has(id)) continue;
      const img = imageCache.get(id);
      if (!img) continue; // 已被 LRU 挤出：客户端等待超时后走 image.fetch 兜底（404 提示）
      this.#pushedImages.add(id); // 先占位：并发批次含同 id 时不双推
      let done = false;
      try {
        for (let offset = 0; offset < img.data.length; offset += IMAGE_CHUNK_CHARS) {
          while (this.#getBuffered() >= ClientSession.#SEND_HIGH_WATER) {
            if (this.#disposed || gen !== this.#watchGen) return;
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 50);
              timer.unref?.();
            });
          }
          if (this.#disposed || gen !== this.#watchGen) return;
          this.#notify("image.chunk", {
            id,
            mime: img.mime,
            offset,
            data: img.data.slice(offset, offset + IMAGE_CHUNK_CHARS),
            eof: offset + IMAGE_CHUNK_CHARS >= img.data.length,
          });
        }
        done = true;
      } finally {
        if (!done) this.#pushedImages.delete(id); // 推完才算数，半途中止的下次重推
      }
    }
  }

  #reply(id, result, error = null) {
    if (id === undefined) return;
    this.#sendMessage(error ? { id, error } : { id, result });
  }

  #notify(method, params) {
    this.#sendMessage({ method, params });
  }

  #sendMessage(message) {
    if (!this.#key) return;
    // 控制通道优先：RPC 应答与全权设备帧直发；观众的通知帧（快照/增量等）
    // 走低优先级 outbox，按 relay 上行水位排空——上行饱和时排在观众帧后面的
    // 不只是观众画面，还有审批推送与分享者自己的操作回执。
    // pong 例外直发：它是连接活性信号，压进积压队列会让观众端误判断线
    if (this.isViewer && message.id === undefined && message.method !== "pong") {
      this.#enqueue(message);
      return;
    }
    this.#send(this.#seal(message));
  }

  // d2c 统一封口：序号在真正发送的时刻分配（直发与 outbox 排空都经此处，
  // 序号与实际发送顺序严格一致，对端按单调递增校验才不会误杀）
  #seal(message) {
    const opts = { deflate: this.#clientDeflate };
    if (this.#seqCap) opts.seq = ++this.#sendSeq;
    return seal(this.#key, "d2c", message, opts);
  }

  #enqueue(message) {
    // 溢出补发待跑期间，后续回放帧直接并入补发范围而不入队：这些帧的区间
    // 都落在 [#replayLow, 实时 #replayOffset) 内，先送达会与补发内容重复；
    // 丢掉它们让「被丢弃的回放条目」保持连续，补发按序追加即无重无漏
    if (this.#replayLow !== null && this.#enqueueReplayFrom !== null) return;
    const size = JSON.stringify(message).length;
    this.#outbox.push({ message, size, replayFrom: this.#enqueueReplayFrom });
    this.#outboxChars += size;
    if (
      this.#outbox.length > ClientSession.#OUTBOX_MAX_FRAMES ||
      this.#outboxChars > ClientSession.#OUTBOX_MAX_CHARS
    ) {
      // 积压超限：整段丢弃（观众允许跳帧），水位回落后追平——尾部模式重发
      // 快照即可；回放模式记下被丢帧的最低条目偏移，排空后从那里补读续传
      for (const frame of this.#outbox) {
        if (frame.replayFrom === null) continue;
        if (this.#replayLow === null || frame.replayFrom < this.#replayLow) {
          this.#replayLow = frame.replayFrom;
        }
      }
      this.#outbox.length = 0;
      this.#outboxChars = 0;
      this.#needsResnapshot = true;
    }
    this.#drainOutbox();
  }

  #drainOutbox() {
    if (this.#drainTimer) return; // 已有排空调度在等水位
    while (this.#outbox.length > 0) {
      const buffered = this.#getBuffered();
      if (buffered >= ClientSession.#SEND_HIGH_WATER) {
        if (!this.#congestedSince) this.#congestedSince = Date.now();
        this.#drainTimer = setTimeout(() => {
          this.#drainTimer = null;
          this.#drainOutbox();
        }, 50);
        this.#drainTimer.unref?.();
        return;
      }
      const { message, size } = this.#outbox.shift();
      this.#outboxChars -= size;
      this.#send(this.#seal(message));
    }
    this.#congestedSince = 0;
    if (this.#needsResnapshot) {
      this.#needsResnapshot = false;
      if (this.#replayPath && this.#replayLow !== null) {
        const from = this.#replayLow;
        this.#replayLow = null;
        this.#resendReplay(from);
      } else {
        this.#tail?.resnapshot(200).catch(() => {});
      }
    }
  }

  // 回放丢帧补发：配合 #enqueue 的并入丢弃，被丢的回放条目是 [from, 实时
  // #replayOffset) 的连续段，按原序追加补齐即无重无漏。单飞——溢出清空队列后
  // drain 会立刻再触发本方法，并发第二条补发流会重发，故只把更低起点并入
  async #resendReplay(from) {
    if (this.#resendingReplay) {
      if (this.#replayLow === null || from < this.#replayLow) this.#replayLow = from;
      return;
    }
    this.#resendingReplay = true;
    try {
      const gen = this.#watchGen; // 会话切换（新 watch）即作废：别把旧偏移用到新文件上
      let at = from;
      // 上界取「触发补发时已答复的偏移」：补发期间并发 session.more 的帧
      // 走正常队列送达，越过它们会重发；仅当又有丢弃时随之外扩
      let target = this.#replayOffset;
      while (this.#replayPath && gen === this.#watchGen) {
        if (this.#replayLow !== null) {
          // 补发期间又有丢弃：并入最低点重来，上界外扩到当下已答复的偏移
          at = Math.min(at, this.#replayLow);
          this.#replayLow = null;
          target = this.#replayOffset;
        }
        if (at >= target) break;
        if (
          this.#outbox.length > 0 ||
          this.#getBuffered() >= ClientSession.#SEND_HIGH_WATER
        ) {
          // 背压：水位没回落或上一批帧没送完就等——溢出会清空 outbox，
          // 只看队列长度会在高水位下读了丢、丢了读地空转
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 50);
            t.unref?.();
          });
          continue;
        }
        const { items } = await readRolloutWindow(this.#replayPath, at, 500);
        if (gen !== this.#watchGen) break; // 读文件期间会话已切换，条目属旧会话，不能发
        if (items.length === 0) break;
        this.#sendItems(this.#watchedThreadId, items, { snapshot: false, replayFrom: at });
        at += items.length;
      }
    } catch {
      // 文件被清理等：回放本身已不可继续，保持静默（连接层语义不变）
    } finally {
      this.#resendingReplay = false;
    }
  }

  dispose() {
    this.#disposed = true; // 在途图片推送循环随之停发
    this.#watchGen++; // 在途 watch 一并作废，避免向已死连接的 hub 订阅泄漏
    this.#stopWatch();
    this.#uploads.clear();
    this.#uploadChars = 0;
    if (this.#drainTimer) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
    this.#outbox.length = 0;
    this.#outboxChars = 0;
    this.#removeAllHubs();
  }
}
