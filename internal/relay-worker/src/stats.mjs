export function createStatsHooks({ productLabel = "cxx" } = {}) {
  return {
    daemonOpen({ env, storage, daemonId, clientCount, meta }) {
      track(env, "daemon_open", daemonId, [0, clientCount], meta);
      return maybeNotifyNewDesktop(env, storage, daemonId, meta, productLabel);
    },
    daemonClose({ env, daemonId, durationSec, code, wasClean, meta }) {
      track(env, "daemon_close", daemonId, [durationSec, code, wasClean ? 1 : 0], meta);
    },
    daemonRejected({ env, storage, daemonId, meta, reason }) {
      track(env, "daemon_rejected", daemonId, [0], meta, reason);
      if (reason === "legacy_owner_conflict") {
        return maybeNotifyLegacyConflict(env, storage, daemonId, meta, productLabel);
      }
    },
    clientOpen({ env, daemonId, clientCount, online, meta }) {
      track(env, "client_open", daemonId, [0, clientCount, online ? 1 : 0], meta);
    },
    clientClose({ env, daemonId, durationSec, remaining, up, down, upB, downB, meta }) {
      track(env, "client_close", daemonId, [durationSec, remaining, up, down, upB, downB], meta);
    },
  };
}

const ACTIVE_DESKTOPS_TRACKED_FROM = "2026-07-15 03:42 UTC";
const ACTIVE_DESKTOPS_FIRST_DAY = "2026-07-15";

export async function handleStats(env, url) {
  if (!(await statsTokenMatches(env.STATS_TOKEN, url.searchParams.get("token")))) {
    return new Response("forbidden\n", { status: 403 });
  }
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return htmlResponse(
      `<h1>CXX 中继统计</h1>` +
        `<p>尚未配置 <code>CF_API_TOKEN</code> / <code>CF_ACCOUNT_ID</code>。</p>` +
        `<p>Cloudflare API Token 需要具备 <b>Account Analytics Read</b> 权限。</p>`,
    );
  }

  const since = "NOW() - INTERVAL '7' DAY";
  try {
    const [desktops, activeDesktops, opens, peaks, closes, apps] = await Promise.all([
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, count(DISTINCT index1) AS n FROM relay_events
         WHERE blob1 = 'daemon_open' AND timestamp > ${since} GROUP BY day`,
      ),
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, count(DISTINCT index1) AS n FROM relay_events
         WHERE blob1 = 'client_open' AND double3 = 1 AND timestamp > ${since} GROUP BY day`,
      ),
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM relay_events
         WHERE blob1 IN ('daemon_open', 'client_open') AND timestamp > ${since} GROUP BY day`,
      ),
      queryAE(
        env,
        `SELECT toDate(timestamp) AS day, max(double2) AS n FROM relay_events
         WHERE blob1 = 'client_open' AND timestamp > ${since} GROUP BY day`,
      ),
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
      queryAE(
        env,
        `SELECT blob2 AS app, count(DISTINCT index1) AS desktops FROM relay_events
         WHERE blob1 = 'daemon_open' AND timestamp > ${since} GROUP BY app`,
      ),
    ]);
    const byDay = new Map();
    const at = (day) => {
      const d = byDay.get(day) ?? { day };
      byDay.set(day, d);
      return d;
    };
    for (const r of desktops.data ?? []) at(r.day).desktops = r.n;
    for (const r of activeDesktops.data ?? []) at(r.day).activeDesktops = r.n;
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
    return htmlResponse(renderStats(rows, apps.data ?? []));
  } catch (e) {
    return new Response("统计查询失败：" + e.message + "\n", { status: 500 });
  }
}

function track(env, event, daemonId, doubles, meta = {}, reason = "") {
  const ae = env?.AE;
  if (!ae || !daemonId) return;
  try {
    ae.writeDataPoint({
      indexes: [daemonId],
      blobs: [
        event,
        appLabel(meta.app),
        osLabel(meta.os),
        countryLabel(meta.country),
        String(meta.version || "unknown").slice(0, 32),
        String(meta.instanceId || "unknown").slice(0, 64),
        String(meta.closeReason || "").slice(0, 80),
        String(reason || "").slice(0, 40),
      ],
      doubles: doubles.map((n) => Math.round(Number(n) || 0)),
    });
  } catch {
    // Metrics must never affect relay forwarding.
  }
}

const LEGACY_CONFLICT_NOTIFY_KEY = "legacyConflictNotifiedAt";
const LEGACY_CONFLICT_NOTIFY_COOLDOWN_MS = 60 * 60_000;

async function maybeNotifyLegacyConflict(env, storage, daemonId, meta = {}, productLabel) {
  try {
    const now = Date.now();
    const notifiedAt = Number(await storage.get(LEGACY_CONFLICT_NOTIFY_KEY)) || 0;
    if (notifiedAt && now - notifiedAt < LEGACY_CONFLICT_NOTIFY_COOLDOWN_MS) {
      return;
    }

    // 先持久化再做外部 I/O；DO storage input/output gates 保证并发请求不会重复认领通知。
    await storage.put(LEGACY_CONFLICT_NOTIFY_KEY, now);

    const app = displayText(appLabel(meta.app || productLabel));
    const os = displayText(osLabel(meta.os));
    const country = displayText(countryLabel(meta.country));
    const version = displayText(meta.version);
    let msg = `<b>${telegramEsc(app)} · 旧客户端连接冲突</b>\n\n`;
    msg += `• ID：<code>${telegramEsc(daemonId)}</code>\n`;
    if (os !== "未知") msg += `• 系统：<b>${telegramEsc(os)}</b>\n`;
    if (country !== "未知") msg += `• 地区：<b>${telegramEsc(country)}</b>\n`;
    if (version !== "未知") msg += `• 版本：<b>${telegramEsc(version)}</b>\n`;
    msg += "• 处理：已在 WebSocket 升级前拒绝，1 小时内不重复通知";

    const result = await notifyTelegram(env, msg);
    if (!result?.skipped) {
      console.info(JSON.stringify({
        event: "telegram_notify_sent",
        reason: "legacy_owner_conflict",
        daemonId,
        status: result.status,
      }));
    }
  } catch (e) {
    console.error(JSON.stringify({
      event: "telegram_notify_error",
      reason: "legacy_owner_conflict",
      daemonId,
      message: String(e?.message || e),
    }));
    // Notification/storage failures must never affect relay ownership or forwarding.
  }
}

async function maybeNotifyNewDesktop(env, storage, daemonId, meta = {}, productLabel) {
  try {
    if (await storage.get("firstSeen")) {
      console.info(JSON.stringify({ event: "telegram_notify_skip", reason: "desktop_already_seen", daemonId }));
      return;
    }
    const lastSeen = await storage.get("lastSeen");
    await storage.put("firstSeen", Date.now());
    if (lastSeen) {
      console.info(JSON.stringify({ event: "telegram_notify_skip", reason: "desktop_had_last_seen", daemonId }));
      return;
    }

    const brief = await todayBrief(env);
    const app = displayText(appLabel(meta.app || productLabel));
    const os = displayText(osLabel(meta.os));
    const country = displayText(countryLabel(meta.country));
    let msg = `<b>${telegramEsc(app)} · 新桌面上线</b>\n\n`;
    if (os !== "未知") msg += `• 系统：<b>${telegramEsc(os)}</b>\n`;
    msg += `• 地区：<b>${telegramEsc(country)}</b>\n` + `• ID：<code>${telegramEsc(daemonId)}</code>\n`;
    if (brief) {
      msg +=
        `\n<b>今日（UTC）</b>\n` +
        `• 桌面：<b>${brief.desktops}</b>\n` +
        `• 活跃桌面：<b>${brief.activeDesktops}</b>\n` +
        `• 连接次数：<b>${brief.conns}</b>`;
    }
    const result = await notifyTelegram(env, msg);
    if (!result?.skipped) console.info(JSON.stringify({ event: "telegram_notify_sent", daemonId, status: result.status }));
  } catch (e) {
    console.error(JSON.stringify({ event: "telegram_notify_error", daemonId, message: String(e?.message || e) }));
    // Notification/storage failures must never affect forwarding.
  }
}

async function todayBrief(env) {
  try {
    const [d, a, c] = await Promise.all([
      queryAE(
        env,
        `SELECT count(DISTINCT index1) AS n FROM relay_events
         WHERE blob1 = 'daemon_open' AND toDate(timestamp) = toDate(NOW())`,
      ),
      queryAE(
        env,
        `SELECT count(DISTINCT index1) AS n FROM relay_events
         WHERE blob1 = 'client_open' AND double3 = 1 AND toDate(timestamp) = toDate(NOW())`,
      ),
      queryAE(
        env,
        `SELECT SUM(_sample_interval) AS n FROM relay_events
         WHERE blob1 IN ('daemon_open', 'client_open') AND toDate(timestamp) = toDate(NOW())`,
      ),
    ]);
    return {
      desktops: Math.round(Number(d.data?.[0]?.n || 0)),
      activeDesktops: Math.round(Number(a.data?.[0]?.n || 0)),
      conns: Math.round(Number(c.data?.[0]?.n || 0)),
    };
  } catch {
    return null;
  }
}

async function notifyTelegram(env, text) {
  const token = env?.TG_BOT_TOKEN;
  const chat = env?.TG_CHAT_ID;
  if (!token || !chat) {
    console.warn(
      JSON.stringify({
        event: "telegram_notify_skip",
        reason: !token ? "missing_bot_token" : "missing_chat_id",
      }),
    );
    return { skipped: true };
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  });
  if (!response.ok) {
    throw new Error(`Telegram ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return { status: response.status };
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

async function statsTokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const enc = new TextEncoder();
  const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(expected))));
  const providedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(provided))));
  if (expectedHash.length !== providedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHash.length; i += 1) diff |= expectedHash[i] ^ providedHash[i];
  return diff === 0;
}

function osLabel(p) {
  const m = { darwin: "macOS", win32: "Windows", linux: "Linux", android: "Android" };
  const k = String(p || "").toLowerCase();
  return m[k] || (p ? String(p) : "unknown");
}

function appLabel(app) {
  return String(app || "unknown").slice(0, 40);
}

function countryLabel(country) {
  const value = String(country || "").toUpperCase();
  return value && value !== "XX" ? value.slice(0, 8) : "unknown";
}

function renderStats(rows, apps = []) {
  const esc = (v) =>
    String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  const int = (v) => Math.round(Number(v || 0));
  const min = (sec) => (sec == null ? "-" : (Number(sec) / 60).toFixed(1));
  const one = (v) => (v == null ? "-" : Number(v).toFixed(1));
  const size = (b) => {
    if (b == null) return "-";
    b = Number(b) || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
    return b + " B";
  };
  const body = rows.length
    ? rows
        .map(
          (r) => {
            const activeDesktops = r.day < ACTIVE_DESKTOPS_FIRST_DAY ? "-" : int(r.activeDesktops);
            return (
            `<tr><td>${esc(r.day)}</td><td>${int(r.desktops)}</td>` +
            `<td>${activeDesktops}</td><td>${int(r.opens)}</td><td>${int(r.peak)}</td>` +
            `<td>${min(r.avgDur)}</td><td>${one(r.avgUp)}</td>` +
            `<td>${int(r.up)}</td><td>${int(r.down)}</td><td>${size(r.bytes)}</td></tr>`
            );
          },
        )
        .join("")
    : `<tr><td colspan="10" style="opacity:.6">暂无数据</td></tr>`;
  const appBody = apps.length
    ? apps
        .sort((a, b) => Number(b.desktops || 0) - Number(a.desktops || 0))
        .map((r) => `<tr><td>${esc(displayText(r.app))}</td><td>${int(r.desktops)}</td></tr>`)
        .join("")
    : `<tr><td colspan="2" style="opacity:.6">暂无按应用标记的数据</td></tr>`;
  return (
    `<h1>CXX 中继统计 · 近 7 天</h1>` +
    `<h2>应用拆分</h2>` +
    `<table class="mini"><thead><tr><th>应用</th><th>桌面</th></tr></thead>` +
    `<tbody>${appBody}</tbody></table>` +
    `<h2>每日共享中继</h2>` +
    `<table><thead><tr>` +
    `<th>日期（UTC）</th><th>桌面</th><th>活跃桌面</th><th>连接次数</th><th>客户端并发峰值</th>` +
    `<th>平均连接时长（分钟）</th><th>平均上行消息</th><th>上行消息</th><th>下行消息</th><th>转发流量</th>` +
    `</tr></thead><tbody>${body}</tbody></table>` +
    `<p class="hint">桌面按 daemon_open 的桌面 ID 去重；活跃桌面按桌面在线时发生 client_open 的桌面 ID 去重；` +
    `该口径自 ${ACTIVE_DESKTOPS_TRACKED_FROM} 起累计，之前显示“−”；连接次数统计 daemon_open + client_open。` +
    `上行=手机或浏览器到桌面，下行=桌面到手机；这里只统计信封元数据，不含消息内容。</p>`
  );
}

function displayText(value) {
  const s = String(value || "").trim();
  return !s || s.toLowerCase() === "unknown" ? "未知" : s;
}

function telegramEsc(value) {
  return String(value ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

function htmlResponse(inner) {
  const doc =
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>CXX 中继统计</title>` +
    `<style>body{background:#0b0b0c;color:#e6e6e6;font:15px/1.6 -apple-system,system-ui,sans-serif;` +
    `max-width:1000px;margin:32px auto;padding:0 16px}h1{font-size:19px;font-weight:600}` +
    `h2{font-size:13px;margin:20px 0 6px;opacity:.7;font-weight:600}` +
    `table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}` +
    `th,td{text-align:left;padding:6px 8px;white-space:nowrap;` +
    `border-bottom:1px solid #222}th{opacity:.6;font-weight:500}b{color:#7dd3fc}` +
    `code{background:#1a1a1c;padding:1px 5px;border-radius:4px}.hint{opacity:.5;font-size:12px}</style>` +
    inner;
  return new Response(doc, { headers: { "content-type": "text/html; charset=utf-8" } });
}
