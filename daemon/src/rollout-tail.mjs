// 实时跟踪 rollout JSONL 文件的追加写入（只读实时查看的数据源）
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { open, stat } from "node:fs/promises";

const SNAPSHOT_MAX_ITEMS = 500;

// 文件身份指纹：首条目的哈希（对客户端是不透明串，只回传不解读）。
// 断点续传时对不上指纹＝文件已被重写/换代，须退回全量快照
export function rolloutIdent(firstItem) {
  if (firstItem === undefined) return null;
  return createHash("sha256").update(JSON.stringify(firstItem)).digest("base64url").slice(0, 16);
}

// 解析 buffer 中的完整 JSONL 行，返回 { items, rest }
export function parseJsonlChunk(text) {
  const items = [];
  let rest = text;
  for (;;) {
    const idx = rest.indexOf("\n");
    if (idx === -1) break;
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      // 半行或损坏行：跳过（追加中的文件可能读到未写完的行，由 rest 缓冲兜底）
    }
  }
  return { items, rest };
}

// 一次性按条目窗口读取 rollout（offset/limit 为条目序号，非字节）。
// 观众回放"从头读"的数据源：首屏 [0,200)，随后向前翻页。返回 { items, total }。
export async function readRolloutWindow(path, offset, limit) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.size === 0) return { items: [], total: 0 };
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    const { items } = parseJsonlChunk(buffer.toString("utf8"));
    const start = Math.max(0, offset | 0);
    const n = Math.max(0, limit | 0);
    return { items: items.slice(start, start + n), total: items.length };
  } finally {
    await handle.close();
  }
}

export class RolloutTail {
  #path;
  #onItems;
  #onError;
  #offset = 0;
  #pendingText = "";
  #watcher = null;
  #reading = false;
  #dirty = false;
  #closed = false;
  #resume = null;
  // 读串行链：resnapshot 与 #readAppended 互斥（并发读会把同一段追加内容
  // 既并进快照又当增量重发，客户端重复渲染且续传游标多计）
  #readChain = Promise.resolve();

  constructor(path, { onItems, onError = () => {}, resume = null }) {
    this.#path = path;
    this.#onItems = onItems;
    this.#onError = onError;
    this.#resume = resume; // {total, ident}：客户端声明已持有 [0,total) 的尾部窗口（断点续传）
  }

  // 回填尾部最多 SNAPSHOT_MAX_ITEMS 条，然后开始监听增量。
  // snapshot 附带 total（rollout 总条数），手机端据此判断"上面还有没有更早的"。
  async start() {
    const all = await this.#serialize(() => this.#readFrom(0));
    // 首屏读文件期间可能已被 close()（快速切会话）：此时装上 watcher/poller
    // 就再没人清理（close 已经跑过了），快照也不该再发
    if (this.#closed) return;
    const ident = all.length ? rolloutIdent(all[0]) : null;
    const r = this.#resume;
    // 断点续传：指纹对得上、文件没缩短、缺口不超过一个快照窗——只补 [r.total, all.length)
    // 的增量（append 快照，客户端不清屏续在末尾）；任一条不满足退回全量尾部快照
    if (r && ident && r.ident === ident && all.length >= r.total
        && all.length - r.total <= SNAPSHOT_MAX_ITEMS) {
      this.#onItems(all.slice(r.total), { snapshot: true, append: true, total: all.length, ident });
    } else {
      this.#onItems(all.slice(-SNAPSHOT_MAX_ITEMS), { snapshot: true, total: all.length, ident });
    }
    this.#watcher = watch(this.#path, () => this.#scheduleRead());
    // Windows 下 fs.watch 对被占用文件可能丢事件，用低频轮询兜底
    this.#poller = setInterval(() => this.#scheduleRead(), 1500);
    this.#poller.unref?.();
  }

  // 手机端「下拉加载更早」：按更大的 limit 重发一次尾部快照。
  // 一致读：与增量读串行，重置游标全量重读并推进 #offset——快照读到的
  // 新追加行随快照下发，不会再被 #readAppended 当增量重发一遍。
  async resnapshot(limit) {
    await this.#serialize(async () => {
      this.#pendingText = "";
      const all = await this.#readFrom(0);
      if (this.#closed) return; // 读文件期间已被 close（切会话）：快照属旧会话，不发
      const n = Math.max(1, Math.min(all.length, limit | 0));
      const ident = all.length ? rolloutIdent(all[0]) : null;
      this.#onItems(all.slice(-n), { snapshot: true, total: all.length, ident });
    });
  }

  // 把读操作排进串行链，保证任意时刻只有一个读在跑
  #serialize(fn) {
    const run = this.#readChain.then(fn);
    this.#readChain = run.catch(() => {});
    return run;
  }

  #poller = null;

  #scheduleRead() {
    if (this.#closed) return;
    if (this.#reading) {
      this.#dirty = true;
      return;
    }
    this.#reading = true;
    this.#serialize(() => this.#readAppended())
      .catch((err) => this.#onError(err))
      .finally(() => {
        this.#reading = false;
        if (this.#dirty) {
          this.#dirty = false;
          this.#scheduleRead();
        }
      });
  }

  async #readAppended() {
    const info = await stat(this.#path);
    if (info.size <= this.#offset) return;
    const items = await this.#readFrom(this.#offset);
    if (items.length > 0 && !this.#closed) {
      this.#onItems(items, { snapshot: false });
    }
  }

  async #readFrom(offset) {
    const handle = await open(this.#path, "r");
    try {
      const info = await handle.stat();
      if (info.size <= offset) return [];
      const length = info.size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      this.#offset = info.size;
      const { items, rest } = parseJsonlChunk(this.#pendingText + buffer.toString("utf8"));
      // 未换行的尾部留待下次拼接；offset 已推进，用文本缓冲衔接
      this.#pendingText = rest;
      return items;
    } finally {
      await handle.close();
    }
  }

  close() {
    this.#closed = true;
    this.#watcher?.close();
    if (this.#poller) clearInterval(this.#poller);
  }
}
