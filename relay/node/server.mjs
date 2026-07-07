#!/usr/bin/env node
// CXX Remote relay —— Node 自托管/本地开发变体
// 与 Cloudflare Worker 版实现相同的转发协议（见 public/PROTOCOL.md §1）。
// 用法：node remote/relay-node/server.mjs [--port 8787] [--host 127.0.0.1]
import { createServer } from "node:http";
import { parseArgs } from "node:util";

import { upgradeConnection } from "./ws-server.mjs";

export function parsePath(pathname) {
  const match = /^\/v1\/(daemon|client)\/([A-Za-z0-9_-]{8,64})$/.exec(pathname);
  if (!match) return null;
  return { role: match[1], daemonId: match[2] };
}

export function createRelayServer({ log = () => {} } = {}) {
  // daemonId -> { daemon: conn|null, clients: Map<cid, conn>, nextCid }
  const rooms = new Map();

  function room(daemonId) {
    let r = rooms.get(daemonId);
    if (!r) {
      r = { daemon: null, clients: new Map(), nextCid: 1, lastSeen: null, epoch: 0 };
      rooms.set(daemonId, r);
    }
    return r;
  }

  function cleanup(daemonId) {
    const r = rooms.get(daemonId);
    if (r && !r.daemon && r.clients.size === 0) rooms.delete(daemonId);
  }

  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("cxx relay ok\n");
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://relay.invalid");
    const target = parsePath(url.pathname);
    if (!target) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const conn = upgradeConnection(req, socket);
    if (!conn) return;
    const r = room(target.daemonId);

    if (target.role === "daemon") {
      r.daemon?.close(); // 新连接顶掉旧连接
      r.daemon = conn;
      // daemon 连接纪元：客户端靠 epoch 变化得知 daemon 侧连接态已重置（顶替路径无 offline 边沿）
      r.epoch += 1;
      log(`daemon 上线: ${target.daemonId}`);
      for (const [cid, client] of r.clients) {
        client.send(JSON.stringify({ t: "status", online: true, epoch: r.epoch }));
        conn.send(JSON.stringify({ t: "open", cid })); // 补发已在线 client 的 open
      }
      conn.onText = (text) => {
        const frame = safeParse(text);
        if (!frame) return;
        if (frame.t === "hb") {
          conn.send(JSON.stringify({ t: "hb" }));
          return;
        }
        if (typeof frame.cid !== "string") return;
        const client = r.clients.get(frame.cid);
        if (!client) return;
        if (frame.t === "msg") {
          client.send(JSON.stringify({ t: "msg", data: frame.data }));
        } else if (frame.t === "close") {
          client.close();
        }
      };
      conn.onClose = () => {
        if (r.daemon === conn) {
          r.daemon = null;
          r.lastSeen = Date.now();
          log(`daemon 下线: ${target.daemonId}`);
          for (const client of r.clients.values()) {
            client.send(JSON.stringify({ t: "status", online: false, lastSeen: r.lastSeen }));
          }
          cleanup(target.daemonId);
        }
      };
      return;
    }

    // client
    const cid = `c${r.nextCid++}`;
    r.clients.set(cid, conn);
    conn.send(JSON.stringify({
      t: "status",
      online: Boolean(r.daemon),
      lastSeen: r.lastSeen,
      ...(r.daemon ? { epoch: r.epoch } : {}),
    }));
    r.daemon?.send(JSON.stringify({ t: "open", cid }));
    conn.onText = (text) => {
      const frame = safeParse(text);
      if (!frame) return;
      if (frame.t === "hb") {
        conn.send(JSON.stringify({ t: "hb" })); // 手机端前台活性探测（与 Worker 形态行为一致）
        return;
      }
      if (frame.t === "msg") {
        r.daemon?.send(JSON.stringify({ t: "msg", cid, data: frame.data }));
      }
    };
    conn.onClose = () => {
      if (r.clients.get(cid) === conn) {
        r.clients.delete(cid);
        r.daemon?.send(JSON.stringify({ t: "close", cid }));
        cleanup(target.daemonId);
      }
    };
  });

  return server;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isDirectRun = process.argv[1]?.endsWith("server.mjs");
if (isDirectRun) {
  const { values } = parseArgs({
    options: { port: { type: "string" }, host: { type: "string" } },
  });
  const port = Number(values.port ?? 8787);
  const host = values.host ?? "127.0.0.1";
  const server = createRelayServer({ log: (m) => console.log(`[relay] ${m}`) });
  server.listen(port, host, () => {
    console.log(`[relay] 监听 ws://${host}:${port}`);
  });
}
