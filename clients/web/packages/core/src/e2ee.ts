// 端到端加密的密码学部分，与 Swift 版、Go 参考实现共用 testdata/e2ee/vectors.json：
// - 每个会话一把 X25519 密钥交换密钥，公钥由身份私钥（Ed25519）签名后在握手时上报；
// - 媒体密钥用 HPKE（DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM，base 模式）逐个加密给房间里的其他成员；
// - 安全码：所有人看到的相同，就说明大家看到的成员列表一致。
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { uidOf } from './identity';

export const KEY_PACKAGE_INFO = 'OpenHane-E2EE-KeyPackage-v1';
const E2EE_KEY_CONTEXT = 'OpenHane-E2EE-Key-v1';
const SAFETY_CONTEXT = 'OpenHane-SafetyCode-v1';

const enc = new TextEncoder();
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** 本次会话的 X25519 密钥交换密钥 */
export interface KeyExchange {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export async function generateKeyExchange(): Promise<KeyExchange> {
  const kp = await suite.kem.generateKeyPair();
  const raw = new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: raw };
}

/** 身份私钥对 X25519 公钥的签名内容："OpenHane-E2EE-Key-v1" ‖ 0x00 ‖ 公钥 */
export function e2eeKeySigInput(x25519Pub: Uint8Array): Uint8Array {
  return concat(enc.encode(E2EE_KEY_CONTEXT), new Uint8Array([0]), x25519Pub);
}

/**
 * 校验成员的 E2EE 公钥：身份公钥必须与 UID 对应（UID 由身份公钥哈希而来），且签名有效。
 * 服务端插入的伪造公钥过不了这一关；它最多能塞进一个新 UID，而这会体现在成员列表和安全码上。
 */
export async function verifyE2EEKey(uid: string, identityPub: Uint8Array, x25519Pub: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (identityPub.length !== 32 || x25519Pub.length !== 32 || signature.length !== 64) return false;
  if ((await uidOf(identityPub)) !== uid) return false;
  try {
    const key = await crypto.subtle.importKey('raw', identityPub as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature as BufferSource, e2eeKeySigInput(x25519Pub) as BufferSource);
  } catch {
    return false;
  }
}

/** 密钥包的 AAD：room_id ‖ 0x00 ‖ from ‖ 0x00 ‖ to ‖ 0x00 ‖ key_index（4 字节大端） */
export function keyPackageAAD(roomId: string, from: string, to: string, keyIndex: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, keyIndex);
  return concat(enc.encode(`${roomId}\0${from}\0${to}\0`), idx);
}

/** 把媒体密钥加密给接收者 */
export async function sealKeyPackage(recipientPub: Uint8Array, aad: Uint8Array, mediaKey: Uint8Array): Promise<{ enc: Uint8Array; ciphertext: Uint8Array }> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(recipientPub.slice().buffer);
  const sender = await suite.createSenderContext({ recipientPublicKey, info: enc.encode(KEY_PACKAGE_INFO).buffer });
  const ct = await sender.seal(mediaKey.slice().buffer, aad.slice().buffer);
  return { enc: new Uint8Array(sender.enc), ciphertext: new Uint8Array(ct) };
}

/** 解开发给自己的密钥包；不是发给自己的、被篡改的或 AAD 不符的都会抛出异常 */
export async function openKeyPackage(privateKey: CryptoKey, encapsulated: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const recipient = await suite.createRecipientContext({ recipientKey: privateKey, enc: encapsulated.slice().buffer, info: enc.encode(KEY_PACKAGE_INFO).buffer });
  return new Uint8Array(await recipient.open(ciphertext.slice().buffer, aad.slice().buffer));
}

/** 测试用：从原始 32 字节导入 X25519 私钥 */
export async function importKeyExchangePrivate(raw: Uint8Array): Promise<CryptoKey> {
  return suite.kem.deserializePrivateKey(raw.slice().buffer);
}

/** 新的随机媒体密钥（32 字节，LiveKit 用 HKDF 从中派生帧加密密钥） */
export function newMediaKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * 安全码：SHA-256("OpenHane-SafetyCode-v1" ‖ 0x00 ‖ 按 UID 排序、去重后的 UID ‖ 0x00 ‖ 身份公钥…)，
 * 取前 30 字节，每 5 字节对 100000 取余，得到 6 组 5 位数字。
 */
export async function safetyCode(members: { uid: string; publicKey: Uint8Array }[]): Promise<string> {
  const byUid = new Map(members.map((m) => [m.uid, m.publicKey]));
  const uids = [...byUid.keys()].sort();
  const parts: Uint8Array[] = [enc.encode(SAFETY_CONTEXT), new Uint8Array([0])];
  for (const u of uids) parts.push(enc.encode(u), new Uint8Array([0]), byUid.get(u)!);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts) as BufferSource));
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    let v = 0n;
    for (const b of d.subarray(i * 5, i * 5 + 5)) v = (v << 8n) | BigInt(b);
    groups.push(String(v % 100000n).padStart(5, '0'));
  }
  return groups.join(' ');
}
