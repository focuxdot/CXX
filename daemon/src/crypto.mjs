// 端到端加密：X25519 + HKDF-SHA256 + AES-256-GCM（见 public/PROTOCOL.md §2）
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

// 明文 JSON 超过此阈值才压缩：小帧压不出收益（deflate 有几字节头，反可能更大），
// 大头是会话列表/对话快照与增量。压缩在加密之前做（加密数据不可压），信封上打 z=1 标记，
// 由对端解密后先 inflate 再 JSON.parse。z 是明文标记，只泄露「该帧可压缩」，无敏感信息。
const DEFLATE_MIN_BYTES = 512;

// 线级协议常量（wire constants）——冻结，勿改。
// daemon 与 web 客户端必须逐字一致才能协商出同一会话密钥；relay 是零知识转发，
// 不参与这些常量。沿用历史值以保持与既有配对设备/托管 web 页的互通性，
// 品牌改名不触及此处（这是加密域分隔符，不是产品名）。
const HKDF_INFO = "codex-zh-remote-v1";
const AAD_PREFIX = "czr1"; // 所有 AAD（含带序号变体）的唯一来源，与 web 端逐字一致
const AAD_C2D = Buffer.from(`${AAD_PREFIX}:c2d`);
const AAD_D2C = Buffer.from(`${AAD_PREFIX}:d2c`);

// X25519 raw 公钥 <-> KeyObject。Node 以 SPKI DER 表示，raw 32 字节位于末尾。
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKeyRaw: exportPublicKeyRaw(publicKey),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function exportPublicKeyRaw(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function publicKeyFromRaw(raw) {
  if (raw.length !== 32) {
    throw new Error(`X25519 公钥长度错误: ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function privateKeyFromPem(pem) {
  return createPrivateKey(pem);
}

// 派生本连接会话密钥。privateKey: KeyObject；peerPublicRaw: Buffer(32)；daemonId: string
export function deriveSessionKey(privateKey, peerPublicRaw, daemonId) {
  const shared = diffieHellman({
    privateKey,
    publicKey: publicKeyFromRaw(peerPublicRaw),
  });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(daemonId), HKDF_INFO, 32));
}

// seq 非空时把序号并入 AAD（`czr1:<dir>:<seq>`）：中继改不了、也重放不了带旧序号的帧。
// seq 为空走冻结的旧常量，保证与不带序号的旧端互通（能力经首帧 sq:1 协商，见 client-session）。
function aad(direction, seq = null) {
  if (direction !== "c2d" && direction !== "d2c") throw new Error(`未知加密方向: ${direction}`);
  if (seq == null) return direction === "c2d" ? AAD_C2D : AAD_D2C;
  return Buffer.from(`${AAD_PREFIX}:${direction}:${seq}`);
}

// 加密 JSON 对象 -> {n, c}（deflate=true 且对端支持时，超阈值的大帧先 deflate 再加密，打 z=1；
// seq 非空时信封带 s=seq 且 AAD 绑定序号，接收端按单调递增校验防中继重放）
export function seal(key, direction, payload, { deflate = false, seq = null } = {}) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(direction, seq));
  let body = Buffer.from(JSON.stringify(payload));
  let z = 0;
  if (deflate && body.length > DEFLATE_MIN_BYTES) {
    const packed = deflateRawSync(body);
    if (packed.length < body.length) {
      body = packed;
      z = 1;
    }
  }
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  const envelope = { n: iv.toString("base64"), c: ciphertext.toString("base64") };
  if (z) envelope.z = 1;
  if (seq != null) envelope.s = seq;
  return envelope;
}

// 解密 {n, c} -> JSON 对象；认证失败抛错。z=1 时解密后先 inflate（compress-then-encrypt 的逆序）。
// 信封带 s 时以序号 AAD 解密（序号被中继篡改/剥离会直接认证失败）；单调性由调用方校验。
export function open(key, direction, envelope) {
  const iv = Buffer.from(envelope.n, "base64");
  const data = Buffer.from(envelope.c, "base64");
  if (iv.length !== 12 || data.length < 16) {
    throw new Error("信封格式错误");
  }
  const ciphertext = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(direction, envelope.s ?? null));
  decipher.setAuthTag(tag);
  let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (envelope.z) plaintext = inflateRawSync(plaintext);
  return JSON.parse(plaintext.toString());
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomId(bytes = 16) {
  return randomBytes(bytes).toString("base64url");
}
