// 零依赖 WebSocket 服务端（RFC 6455 最小实现：文本帧、分片、ping/pong、close）
import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_FRAME_BYTES = 256 * 1024;

export function acceptKey(secWebSocketKey) {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

// 构造服务端 -> 客户端数据帧（不掩码）
export function encodeFrame(payload, opcode = 0x1) {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload;
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

// 从缓冲解析一帧；不完整返回 null
export function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error("帧超限");
    length = Number(big);
    offset = 10;
  }
  if (length > MAX_FRAME_BYTES) throw new Error("帧超限");
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { fin, opcode, payload, consumed: offset + length };
}

// 将 net.Socket 升级为 WebSocket 连接对象
export function upgradeConnection(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n"),
  );

  const conn = {
    socket,
    onText: () => {},
    onClose: () => {},
    send(text) {
      if (!socket.destroyed) socket.write(encodeFrame(text));
    },
    close() {
      if (!socket.destroyed) {
        socket.write(encodeFrame(Buffer.alloc(0), 0x8));
        socket.end();
      }
    },
  };

  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0; // 分片累计上限：单帧限 256KiB，但无限续片一样能耗尽内存
  let fragmentOpcode = 0;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    conn.onClose();
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        switch (frame.opcode) {
          case 0x0: // continuation
            fragmentBytes += frame.payload.length;
            if (fragmentBytes > MAX_FRAME_BYTES) throw new Error("分片总量超限");
            fragments.push(frame.payload);
            if (frame.fin) {
              const whole = Buffer.concat(fragments);
              fragments = [];
              fragmentBytes = 0;
              if (fragmentOpcode === 0x1) conn.onText(whole.toString("utf8"));
            }
            break;
          case 0x1: // text
          case 0x2: // binary（协议只用文本，二进制忽略内容）
            if (frame.fin) {
              if (frame.opcode === 0x1) conn.onText(frame.payload.toString("utf8"));
            } else {
              fragments = [frame.payload];
              fragmentBytes = frame.payload.length;
              fragmentOpcode = frame.opcode;
            }
            break;
          case 0x8: // close
            conn.close();
            finish();
            return;
          case 0x9: // ping
            if (!socket.destroyed) socket.write(encodeFrame(frame.payload, 0xa));
            break;
          case 0xa: // pong
            break;
          default:
            break;
        }
      }
    } catch {
      socket.destroy();
      finish();
    }
  });
  socket.on("close", finish);
  socket.on("error", () => socket.destroy());
  return conn;
}
