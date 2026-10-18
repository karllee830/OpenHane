// 密钥身份：每个服务器的 Ed25519 私钥由主种子派生，UID 由公钥计算。
// 与服务端 internal/identity 共用测试向量。

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const enc = new TextEncoder();

export interface ServerIdentity {
  /** 签名用私钥（不可导出） */
  privateKey: CryptoKey;
  /** 32 字节 Ed25519 公钥 */
  publicKey: Uint8Array;
  uid: string;
}

/** HKDF-SHA256(ikm = 主种子, salt = "OpenHane-Identity-v1", info = server_id) → Ed25519 种子 */
export async function deriveIdentity(masterSeed: Uint8Array, serverId: Uint8Array): Promise<ServerIdentity> {
  const ikm = await crypto.subtle.importKey('raw', masterSeed as BufferSource, 'HKDF', false, ['deriveBits']);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('OpenHane-Identity-v1'), info: serverId as BufferSource },
      ikm,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  // 先以可导出方式导入取公钥，再以不可导出方式导入用于签名
  const exportable = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', exportable);
  const publicKey = base64UrlDecode(jwk.x!);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  seed.fill(0);
  pkcs8.fill(0);
  return { privateKey, publicKey, uid: await uidOf(publicKey) };
}

/** UID = base32(SHA-256(公钥)) 的前 20 个字符，小写 */
export async function uidOf(publicKey: Uint8Array): Promise<string> {
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey as BufferSource));
  return base32(sum).slice(0, 20).toLowerCase();
}

/** 界面展示用的短 UID，如 k3m9-x2qa */
export function shortUid(uid: string): string {
  return uid.length < 8 ? uid : `${uid.slice(0, 4)}-${uid.slice(4, 8)}`;
}

/** 鉴权签名内容："OpenHane-Auth-v1" || 0x00 || server_id || nonce || seen_spki || timestamp_ms（大端 8 字节） */
export function authSigInput(serverId: Uint8Array, nonce: Uint8Array, seenSpki: Uint8Array, timestampMs: bigint): Uint8Array {
  const ctx = enc.encode('OpenHane-Auth-v1');
  const out = new Uint8Array(ctx.length + 1 + serverId.length + nonce.length + seenSpki.length + 8);
  let o = 0;
  out.set(ctx, o);
  o += ctx.length + 1; // 0x00 分隔
  out.set(serverId, o);
  o += serverId.length;
  out.set(nonce, o);
  o += nonce.length;
  out.set(seenSpki, o);
  o += seenSpki.length;
  new DataView(out.buffer).setBigUint64(o, timestampMs, false);
  return out;
}

export async function sign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, data as BufferSource));
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
