// WebRTC 局域网直连：与 RelayLink 平级的第二条客户端来源（见 PROTOCOL.md §3.9）。
//
// 信令走已鉴权的中继连接（client-session 的 rtc.offer 方法转入 handleOffer），
// DataChannel 打开后产出本地 cid（rtc-N，与中继的 c… 前缀空间隔离）喂给上层——
// E2E 信封、鉴权、序号防重放在直连通道上逐字节复用，本模块对信封内容零感知。
// 双方都只用 host/mDNS candidate（不配 STUN/TURN）：同网直连，跨网自然失败回落中继。
import werift from "./vendor/werift.cjs";

const { RTCPeerConnection } = werift;

// 与中继帧上限对齐（PROTOCOL.md §1）：SDP 里通告给浏览器的单消息上限。
// 浏览器自己通告的也是 256KiB（Chrome/Safari 皆然），双向恰好与既有协议约束一致。
const MAX_MESSAGE_SIZE = 256 * 1024;
// 单帧入站硬上限（字符）：256KiB 信封 + 少量余量，超限即断——不给恶意对端堆内存的面
const MAX_INBOUND_CHARS = 300_000;
const MAX_PEERS = 8; // 并发 PeerConnection 上限（手机通常 1~2 台，防病态场景）
const OPEN_TIMEOUT_MS = 30_000; // answer 发出后这么久 DataChannel 没打开即弃
const NEGOTIATE_TIMEOUT_MS = 5_000; // setRemote/createAnswer 总限时：werift 对畸形 SDP 会挂起而非抛错
const SDP_MAX_CHARS = 64_000;
// 空闲回收：直连没有中继替我们看管 TCP——手机切后台/静默消失时 werift 未必能察觉，
// 不回收会永久滞留 ClientSession（假在线撑防睡眠、抑制通知）。前台客户端每 25s 一拍
// ping，5 分钟无任何入站帧即判死；回前台后客户端会自动重新升级直连。
const IDLE_TIMEOUT_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

// werift 收集 host candidate 本机瞬间完成；订阅完成事件并设上限兜底
function waitIceComplete(pc, capMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    // 短命兜底（≤capMs、完成即清），保持 ref：unref 的守卫在安静进程里可能永不触发
    const timer = setTimeout(resolve, capMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

export class RtcLink {
  #handlers; // { onOpen(cid, io), onMessage(cid, data), onClose(cid), log }
  #seq = 0;
  #peers = new Map(); // pc -> { cid|null, channel|null, owner, openTimer, lastSeenAt }
  #byOwner = new Map(); // 信令连接 -> 其最近一次 offer 的 pc（重协商时替换旧的）
  #sweeper;
  #stopped = false;

  constructor(handlers) {
    this.#handlers = handlers;
    this.#sweeper = setInterval(() => this.#sweepIdle(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref?.();
  }

  get peerCount() {
    return this.#peers.size;
  }

  // 处理一次 rtc.offer（vanilla ICE：单次往返，answer 携带全部 candidate，无 trickle）。
  // owner 是发起信令的 ClientSession——同一连接重发 offer 视为重试，顶掉旧的未完成协商。
  async handleOffer(owner, params) {
    if (this.#stopped) throw new Error("直连已停用");
    const { type, sdp } = params ?? {};
    if (type !== "offer" || typeof sdp !== "string" || sdp.length === 0 || sdp.length > SDP_MAX_CHARS) {
      throw new Error("offer 参数非法");
    }
    const prev = this.#byOwner.get(owner);
    if (prev && !this.#peers.get(prev)?.cid) this.#drop(prev); // 只顶掉未开通的旧协商，已建立的连接不动
    if (this.#peers.size >= MAX_PEERS) throw new Error("直连连接数已达上限");

    const pc = new RTCPeerConnection({ iceServers: [], maxMessageSize: MAX_MESSAGE_SIZE });
    const entry = { cid: null, channel: null, owner, openTimer: null, lastSeenAt: Date.now() };
    this.#peers.set(pc, entry);
    this.#byOwner.set(owner, pc);
    entry.openTimer = setTimeout(() => {
      if (!entry.cid) this.#drop(pc); // 协商成功但通道一直没开：对端已放弃
    }, OPEN_TIMEOUT_MS);
    entry.openTimer.unref?.();
    pc.onDataChannel.subscribe((channel) => this.#adopt(pc, entry, channel));
    pc.connectionStateChange.subscribe((state) => {
      // disconnected 在浏览器静默消失（切网/杀进程）时是唯一及时信号，直接回收——
      // 客户端侧把直连当易失通道，随时准备回落中继再重升级，早断优于假活
      if (state === "failed" || state === "closed" || state === "disconnected") this.#drop(pc);
    });
    try {
      // 总限时兜底：werift 收到畸形 SDP 时可能既不抛错也不了结 promise，
      // 不设限会让本次 rpc 永不应答、pc 悬到 openTimer 才回收
      let timer;
      const timeout = new Promise((_, reject) => {
        // 保持 ref（短命、成功即清）：unref 的守卫会被空转的事件循环跳过，等于没设
        timer = setTimeout(() => reject(new Error("协商超时")), NEGOTIATE_TIMEOUT_MS);
      });
      await Promise.race([
        (async () => {
          await pc.setRemoteDescription({ type, sdp });
          await pc.setLocalDescription(await pc.createAnswer());
          await waitIceComplete(pc, 1500);
        })(),
        timeout,
      ]);
      clearTimeout(timer);
    } catch (err) {
      this.#drop(pc);
      throw new Error(`协商失败: ${err.message}`);
    }
    const local = pc.localDescription;
    if (!local?.sdp) {
      this.#drop(pc);
      throw new Error("协商失败: 未生成 answer");
    }
    return { type: "answer", sdp: local.sdp };
  }

  #adopt(pc, entry, channel) {
    if (entry.cid || this.#stopped) return; // 每个 pc 只认第一条通道
    if (entry.openTimer) clearTimeout(entry.openTimer);
    const cid = `rtc-${++this.#seq}`;
    entry.cid = cid;
    entry.channel = channel;
    entry.lastSeenAt = Date.now();
    channel.onMessage.subscribe((raw) => {
      const text = String(raw);
      if (text.length > MAX_INBOUND_CHARS) {
        this.#handlers.log(`rtc ${cid} 入站帧超限（${text.length} 字符），断开`);
        this.#drop(pc);
        return;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return; // 非 JSON 帧忽略（与 relay 的未知帧语义一致）
      }
      entry.lastSeenAt = Date.now();
      this.#handlers.onMessage(cid, data);
    });
    channel.stateChanged.subscribe((state) => {
      if (state === "closed" || state === "closing") this.#drop(pc);
    });
    this.#handlers.onOpen(cid, {
      send: (data) => {
        try {
          channel.send(JSON.stringify(data));
        } catch {
          // 发送失败＝通道已死：交给状态事件/空闲回收收尾，单帧丢弃不抛上层
        }
      },
      close: () => this.#drop(pc),
      // 观众/图片推送的背压水位按本通道自己的缓冲算，不能挪用中继 ws 的
      bufferedAmount: () => entry.channel?.bufferedAmount ?? 0,
    });
  }

  #drop(pc) {
    const entry = this.#peers.get(pc);
    if (!entry) return; // 已回收（close 事件与显式 close 会重入）
    this.#peers.delete(pc);
    if (entry.openTimer) clearTimeout(entry.openTimer);
    if (this.#byOwner.get(entry.owner) === pc) this.#byOwner.delete(entry.owner);
    try {
      pc.close();
    } catch {}
    if (entry.cid) this.#handlers.onClose(entry.cid);
  }

  #sweepIdle() {
    const now = Date.now();
    for (const [pc, entry] of this.#peers) {
      if (entry.cid && now - entry.lastSeenAt > IDLE_TIMEOUT_MS) {
        this.#handlers.log(`rtc ${entry.cid} 空闲超时，回收直连`);
        this.#drop(pc);
      }
    }
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#sweeper);
    for (const pc of [...this.#peers.keys()]) this.#drop(pc);
  }
}
