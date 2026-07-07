// Webhook 通知：任务完成 / 需要审批时主动推到手机，弥补国内 Web Push 不可用。
// 关键约束：通知走第三方明文渠道，只发摘要（事件类型 + 会话名），
// 绝不含命令原文、代码、文件路径（见 public/SECURITY.md 安全需求）。
const TIMEOUT_MS = 8000;
const DEFAULT_BARK_SERVER = "https://api.day.app";

export function normalizeNotifier(n) {
  if (n?.type !== "bark" || typeof n.key !== "string") return n;
  const raw = n.key.trim();
  const parsed = parseBarkUrl(raw);
  if (!parsed) return { ...n, key: raw };

  const { key: _key, server: _server, ...rest } = n;
  return parsed.server === DEFAULT_BARK_SERVER
    ? { ...rest, type: "bark", key: parsed.key }
    : { ...rest, type: "bark", key: parsed.key, server: parsed.server };
}

function parseBarkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const key = url.pathname.split("/").filter(Boolean)[0];
  if (!key) return null;
  return { key: safeDecode(key), server: url.origin };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 构造单个 provider 的请求。返回 { url, init } 供 fetch 调用。
// link 为可选深链（打开手机端并直达对应会话），只含 webUrl + 会话 id，不含内容。
export function buildRequest(n, title, body, link) {
  n = normalizeNotifier(n);
  switch (n.type) {
    case "bark": {
      // Bark（iOS，开源自托管友好）。默认官方服务器，可用 server 覆盖。
      // url 字段：点通知直接打开手机端页面。
      const base = (n.server || DEFAULT_BARK_SERVER).replace(/\/$/, "");
      return {
        url: `${base}/${encodeURIComponent(n.key)}`,
        init: json({ title, body, group: "C叉叉", ...(link ? { url: link } : {}) }),
      };
    }
    case "serverchan":
      // Server 酱（微信推送）
      return {
        url: `https://sctapi.ftqq.com/${encodeURIComponent(n.key)}.send`,
        init: json({ title, desp: link ? `${body}\n\n[打开 Codex 远程](${link})` : body }),
      };
    case "wecom":
      // 企业微信群机器人
      return { url: n.url, init: json({ msgtype: "text", text: { content: withLink(title, body, link) } }) };
    case "dingtalk":
      // 钉钉群机器人
      return { url: n.url, init: json({ msgtype: "text", text: { content: withLink(title, body, link) } }) };
    case "custom":
      // 自定义 webhook：收 {title, body, source, link?}
      return { url: n.url, init: json({ title, body, source: "cxx-remote", ...(link ? { link } : {}) }) };
    default:
      return null;
  }
}

function withLink(title, body, link) {
  return link ? `${title}\n${body}\n${link}` : `${title}\n${body}`;
}

function json(obj) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// 脱敏展示（日志用）：不暴露完整 key/url
export function redact(n) {
  n = normalizeNotifier(n);
  if (n.key) return `${n.type}:${n.key.slice(0, 4)}…`;
  if (n.url) {
    try {
      return `${n.type}:${new URL(n.url).host}`;
    } catch {
      return n.type;
    }
  }
  return n.type;
}

export class Notifier {
  #notifiers;
  #fetch;
  #log;

  constructor(notifiers = [], { fetch = globalThis.fetch, log = () => {} } = {}) {
    this.#notifiers = notifiers;
    this.#fetch = fetch;
    this.#log = log;
  }

  get count() {
    return this.#notifiers.length;
  }

  // 并发发送到所有已配置渠道；单个失败不影响其他，只记日志
  async send(title, body, link) {
    if (this.#notifiers.length === 0) return;
    await Promise.allSettled(
      this.#notifiers.map(async (n) => {
        const req = buildRequest(n, title, body, link);
        if (!req?.url) return;
        try {
          const res = await this.#fetch(req.url, {
            ...req.init,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) this.#log(`通知发送失败 ${redact(n)}: HTTP ${res.status}`);
        } catch (err) {
          this.#log(`通知发送异常 ${redact(n)}: ${err.message}`);
        }
      }),
    );
  }
}
