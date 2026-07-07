// CXX Remote relay —— Cloudflare Worker + Durable Objects 变体
// 与 relay/node/server.mjs 实现相同的转发协议（见 public/PROTOCOL.md §1）。
// 使用 WebSocket Hibernation API：空闲连接不产生 duration 计费。

const PATH_RE = /^\/v1\/(daemon|client)\/([A-Za-z0-9_-]{8,64})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin/stats") {
      return handleStats(env, url);
    }
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
      return new Response("cxx relay ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [, , daemonId] = match;
    const stub = env.ROOM.get(env.ROOM.idFromName(daemonId));
    return stub.fetch(request); // 原样透传，保留 Upgrade 语义；角色由 DO 从 URL 解析
  },
};

export class RelayRoom {
  #state;
  #env;

  constructor(state, env) {
    this.#state = state;
    this.#env = env;
    // hb 在边缘自动应答：不唤醒 DO（省 duration 计费），daemon 与手机端通用。
    // 匹配是逐字符的，两端发送串必须与这里完全一致。
    this.#state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'),
    );
  }

  async fetch(request) {
    const parsed = PATH_RE.exec(new URL(request.url).pathname);
    const role = parsed?.[1];
    const daemonId = parsed?.[2];
    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = [pair[0], pair[1]];

    if (role === "daemon") {
      for (const old of this.#state.getWebSockets("daemon")) {
        try {
          old.close(1000, "replaced");
        } catch {
          // 已失效
        }
      }
      this.#state.acceptWebSocket(serverEnd, ["daemon"]);
      serverEnd.serializeAttachment({ daemonId, openedAt: Date.now() });
      this.#track("daemon_open", daemonId, [0, this.#state.getWebSockets("client").length]);
      // 不 await：绝不能阻塞 101 握手；活跃 WS 保活后台跑完。
      // os 来自 daemon 连接 URL 的 ?os=（daemon 侧 process.platform）；地区来自 CF 注入头。
      this.#maybeNotifyNewDesktop(daemonId, {
        os: new URL(request.url).searchParams.get("os") || "",
        country: request.headers.get("cf-ipcountry") || "",
      });
      this.#broadcastToClients({ t: "status", online: true });
      for (const client of this.#state.getWebSockets("client")) {
        const cid = client.deserializeAttachment()?.cid;
        if (cid) serverEnd.send(JSON.stringify({ t: "open", cid })); // 补发已在线 client 的 open
      }
    } else {
      const cid = `c${crypto.randomUUID().slice(0, 8)}`;
      this.#state.acceptWebSocket(serverEnd, ["client", `cid:${cid}`]);
      serverEnd.serializeAttachment({ cid, daemonId, openedAt: Date.now(), up: 0, down: 0, upB: 0, downB: 0 });
      this.#track("client_open", daemonId, [0, this.#state.getWebSockets("client").length]);
      const online = this.#daemon() !== null;
      // lastSeen 存 DO storage，跨 hibernation/迁移仍可用
      const lastSeen = online ? null : ((await this.#state.storage.get("lastSeen")) ?? null);
      serverEnd.send(JSON.stringify({ t: "status", online, lastSeen }));
      this.#safeSend(this.#daemon(), JSON.stringify({ t: "open", cid }));
    }
    return new Response(null, { status: 101, webSocket: clientEnd });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 256 * 1024) {
      ws.close(1009, "frame too large");
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      this.#fromDaemon(ws, frame, raw.length); // raw.length = 整条帧原始大小（不管 data 是串还是对象）
    } else {
      this.#fromClient(ws, frame, raw.length);
    }
  }

  async webSocketClose(ws) {
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      // 仅当没有其他 daemon 连接（如顶替的新连接）时才广播下线；
      // 关闭回调执行时自身可能仍在 getWebSockets 列表里，须按身份排除
      const others = this.#state.getWebSockets("daemon").filter((s) => s !== ws);
      if (others.length === 0) {
        const lastSeen = Date.now();
        await this.#state.storage.put("lastSeen", lastSeen);
        this.#broadcastToClients({ t: "status", online: false, lastSeen });
      }
      const datt = ws.deserializeAttachment();
      this.#track("daemon_close", datt?.daemonId, [secondsSince(datt?.openedAt), 0]);
      return;
    }
    const att = ws.deserializeAttachment();
    if (att?.cid) this.#safeSend(this.#daemon(), JSON.stringify({ t: "close", cid: att.cid }));
    const remaining = this.#state.getWebSockets("client").filter((s) => s !== ws).length;
    this.#track("client_close", att?.daemonId, [
      secondsSince(att?.openedAt),
      remaining,
      att?.up ?? 0,
      att?.down ?? 0,
      att?.upB ?? 0,
      att?.downB ?? 0,
    ]);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  #fromDaemon(ws, frame, size = 0) {
    if (frame.t === "hb") {
      this.#safeSend(ws, JSON.stringify({ t: "hb" }));
      return;
    }
    if (typeof frame.cid !== "string") return;
    const client = this.#clientByCid(frame.cid);
    if (!client) return;
    if (frame.t === "msg") {
      const catt = client.deserializeAttachment(); // 下行计数记在目标 client 上
      if (catt) {
        catt.down = (catt.down ?? 0) + 1;
        catt.downB = (catt.downB ?? 0) + size;
        client.serializeAttachment(catt);
      }
      this.#safeSend(client, JSON.stringify({ t: "msg", data: frame.data }));
    } else if (frame.t === "close") {
      try {
        client.close(1000, "closed by daemon");
      } catch {
        // 已失效
      }
    }
  }

  #fromClient(ws, frame, size = 0) {
    if (frame.t === "hb") {
      this.#safeSend(ws, '{"t":"hb"}'); // 兜底：auto-response 未生效（非休眠路径）时仍应答
      return;
    }
    if (frame.t !== "msg") return;
    const att = ws.deserializeAttachment();
    if (!att?.cid) return;
    att.up = (att.up ?? 0) + 1; // 上行计数记在发送方 client 上
    att.upB = (att.upB ?? 0) + size;
    ws.serializeAttachment(att);
    this.#safeSend(this.#daemon(), JSON.stringify({ t: "msg", cid: att.cid, data: frame.data }));
  }

  // 休眠列表里可能滞留已断开但未触发 close 回调的 socket（实测会让 send() 抛
  // "Can't call WebSocket send() after close()" 并把整个 DO 打成 500），
  // 所以取 daemon 一律过滤 readyState，发送一律走 #safeSend。
  #daemon() {
    const sockets = this.#state
      .getWebSockets("daemon")
      .filter((s) => s.readyState === 1); // 1 = OPEN（workerd 的常量命名有历史差异，用数值最稳）
    return sockets.length > 0 ? sockets[sockets.length - 1] : null;
  }

  #safeSend(ws, text) {
    if (!ws) return;
    try {
      ws.send(text);
    } catch {
      // 连接已失效，忽略
    }
  }

  #clientByCid(cid) {
    const sockets = this.#state.getWebSockets(`cid:${cid}`);
    return sockets.length > 0 ? sockets[0] : null;
  }

  #broadcastToClients(frame) {
    const text = JSON.stringify(frame);
    for (const ws of this.#state.getWebSockets("client")) {
      try {
        ws.send(text);
      } catch {
        // 连接已失效，忽略
      }
    }
  }

  // 首次见到某台桌面时 Telegram 通知运营方。判定「新」= 该 DO 从未记过 firstSeen。
  // 已有 lastSeen（部署前就断开过）的老桌面：静默补记 firstSeen，不误报。
  async #maybeNotifyNewDesktop(daemonId, meta = {}) {
    try {
      if (await this.#state.storage.get("firstSeen")) return;
      const lastSeen = await this.#state.storage.get("lastSeen");
      await this.#state.storage.put("firstSeen", Date.now());
      if (lastSeen) return; // 老桌面，只补基线不通知
      const brief = await this.#todayBrief();
      const os = osLabel(meta.os); // 未带 ?os= 时为「未知」
      const country = meta.country && meta.country !== "XX" ? meta.country : "未知";
      let msg = `🖥️ *cxx · 新增活跃桌面*\n\n`;
      if (os !== "未知") msg += `• 系统：*${os}*\n`; // 拿得到才显示，省掉常驻「未知」
      msg += `• 地区：*${country}*\n` + `• ID：\`${daemonId}\`\n`;
      if (brief) {
        msg +=
          `\n📊 *今日数据（UTC）*\n` +
          `• 活跃桌面：*${brief.desktops}*\n` +
          `• 连接次数：*${brief.conns}*`;
      }
      await this.#notifyTelegram(msg);
    } catch {
      // 通知/存储失败绝不影响转发
    }
  }

  // 今日（UTC 日）概览：活跃桌面数 + 连接次数。查不到就返回 null（不阻断通知）。
  async #todayBrief() {
    try {
      const [d, c] = await Promise.all([
        queryAE(
          this.#env,
          `SELECT count(DISTINCT index1) AS n FROM relay_events
           WHERE blob1 = 'daemon_open' AND toDate(timestamp) = toDate(NOW())`,
        ),
        queryAE(
          this.#env,
          `SELECT SUM(_sample_interval) AS n FROM relay_events
           WHERE blob1 = 'client_open' AND toDate(timestamp) = toDate(NOW())`,
        ),
      ]);
      return {
        desktops: Math.round(Number(d.data?.[0]?.n || 0)),
        conns: Math.round(Number(c.data?.[0]?.n || 0)),
      };
    } catch {
      return null;
    }
  }

  async #notifyTelegram(text) {
    const token = this.#env?.TG_BOT_TOKEN;
    const chat = this.#env?.TG_CHAT_ID;
    if (!token || !chat) return; // 未配置则静默跳过
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
      });
    } catch {
      // 通知失败绝不影响转发
    }
  }

  // 连接生命周期埋点（只记元数据，不碰 E2E 密文）：daemon/client 上下线各一条。
  // 消息数/字节在连接期内累加进 attachment（扛 hibernation），关闭时汇总成 1 条，
  // 不逐条打点，量级极小、远在免费 10 万点/天之内；失败绝不影响转发。
  #track(event, daemonId, doubles) {
    const ae = this.#env?.AE;
    if (!ae || !daemonId) return;
    try {
      ae.writeDataPoint({
        indexes: [daemonId], // 唯一索引：用于「去重数活跃桌面」
        blobs: [event], // daemon_open|daemon_close|client_open|client_close
        // client_close: [时长秒, 剩余并发, 上行条数, 下行条数, 上行字节, 下行字节]
        // 其余事件:     [时长秒, 并发数]
        doubles: doubles.map((n) => Math.round(Number(n) || 0)),
      });
    } catch {
      // 埋点失败绝不影响转发
    }
  }
}

function secondsSince(openedAt) {
  if (!openedAt) return 0;
  return Math.max(0, (Date.now() - openedAt) / 1000);
}

function osLabel(p) {
  const m = { darwin: "macOS", win32: "Windows", linux: "Linux", android: "Android" };
  const k = String(p || "").toLowerCase();
  return m[k] || (p ? String(p) : "未知");
}

// GET /admin/stats?token=... —— 只读统计页，内部走 Analytics Engine SQL API。
async function handleStats(env, url) {
  if (!env.STATS_TOKEN || url.searchParams.get("token") !== env.STATS_TOKEN) {
    return new Response("forbidden\n", { status: 403 });
  }
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return htmlResponse(
      `<h1>cxx relay stats</h1>` +
        `<p>尚未配置 <code>CF_API_TOKEN</code> / <code>CF_ACCOUNT_ID</code>。</p>` +
        `<p>需要一个带 <b>Account Analytics Read</b> 权限的 API token。</p>`,
    );
  }
  // AE SQL 类型严格（无隐式 bool→int / toFloat64），每个指标各一条干净查询，JS 里合并。
  const since = "NOW() - INTERVAL '7' DAY";
  try {
    const [desktops, opens, peaks, closes] = await Promise.all([
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, count(DISTINCT index1) AS n FROM relay_events
         WHERE blob1 IN ('daemon_open', 'client_open') AND timestamp > ${since} GROUP BY day`,
      ),
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM relay_events
         WHERE blob1 = 'client_open' AND timestamp > ${since} GROUP BY day`,
      ),
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, max(double2) AS n FROM relay_events
         WHERE blob1 = 'client_open' AND timestamp > ${since} GROUP BY day`,
      ),
      // 已结束连接的汇总：时长、上/下行消息、流量、平均每次上行（=上行总数/连接数）。
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day,
                SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_dur,
                SUM(_sample_interval * double3) AS up_total,
                SUM(_sample_interval * double4) AS down_total,
                SUM(_sample_interval * (double5 + double6)) AS bytes_total,
                SUM(_sample_interval * double3) / SUM(_sample_interval) AS avg_up
         FROM relay_events WHERE blob1 = 'client_close' AND timestamp > ${since} GROUP BY day`,
      ),
    ]);
    const byDay = new Map();
    const at = (day) => {
      const d = byDay.get(day) ?? { day };
      byDay.set(day, d);
      return d;
    };
    for (const r of desktops.data ?? []) at(r.day).desktops = r.n;
    for (const r of opens.data ?? []) at(r.day).opens = r.n;
    for (const r of peaks.data ?? []) at(r.day).peak = r.n;
    for (const r of closes.data ?? []) {
      const d = at(r.day);
      d.avgDur = r.avg_dur;
      d.up = r.up_total;
      d.down = r.down_total;
      d.bytes = r.bytes_total;
      d.avgUp = r.avg_up;
    }
    const rows = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    return htmlResponse(renderStats(rows));
  } catch (e) {
    return new Response("stats error: " + e.message + "\n", { status: 500 });
  }
}

async function queryAE(env, sql) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: sql,
    },
  );
  if (!r.ok) throw new Error(`AE ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function renderStats(rows) {
  const esc = (v) =>
    String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  const int = (v) => Math.round(Number(v || 0));
  const min = (sec) => (sec == null ? "—" : (Number(sec) / 60).toFixed(1)); // 分钟
  const one = (v) => (v == null ? "—" : Number(v).toFixed(1));
  const size = (b) => {
    if (b == null) return "—";
    b = Number(b) || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
    return b + " B";
  };
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.day)}</td><td>${int(r.desktops)}</td>` +
            `<td>${int(r.opens)}</td><td>${int(r.peak)}</td>` +
            `<td>${min(r.avgDur)}</td><td>${one(r.avgUp)}</td>` +
            `<td>${int(r.up)}</td><td>${int(r.down)}</td><td>${size(r.bytes)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="9" style="opacity:.6">暂无数据</td></tr>`;
  return (
    `<h1>cxx relay · 近 7 天</h1>` +
    `<table><thead><tr>` +
    `<th>日期(UTC)</th><th>活跃桌面</th><th>连接次数</th><th>并发峰值</th>` +
    `<th>平均连接时长</th><th>平均每次上行</th><th>上行消息</th><th>下行消息</th><th>转发流量</th>` +
    `</tr></thead><tbody>${body}</tbody></table>` +
    `<p class="hint">时长=分钟；「平均每次上行」=每条已结束连接的上行消息数（反映使用强度）；` +
    `上行=手机→桌面、下行=桌面→手机，均为信封元数据、不含内容。` +
    `活跃桌面≈当日去重 daemon 数。免费 DO 时长上限 13,000 GB·秒/天。</p>`
  );
}

function htmlResponse(inner) {
  const doc =
    `<!doctype html><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>relay stats</title>` +
    `<style>body{background:#0b0b0c;color:#e6e6e6;font:15px/1.6 -apple-system,system-ui,sans-serif;` +
    `max-width:1000px;margin:32px auto;padding:0 16px}h1{font-size:19px;font-weight:600}` +
    `table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}` +
    `th,td{text-align:left;padding:6px 8px;white-space:nowrap;` +
    `border-bottom:1px solid #222}th{opacity:.6;font-weight:500}b{color:#7dd3fc}` +
    `code{background:#1a1a1c;padding:1px 5px;border-radius:4px}.hint{opacity:.5;font-size:12px}</style>` +
    inner;
  return new Response(doc, { headers: { "content-type": "text/html; charset=utf-8" } });
}
