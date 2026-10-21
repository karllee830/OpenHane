// 端到端加密的密码学部分，与 Swift 版、Go 参考实现共用 testdata/e2ee/vectors.json：
// - 每个会话一把 X25519 密钥交换密钥，公钥由身份私钥（Ed25519）签名后在握手时上报；
// - 媒体密钥用 HPKE（DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM，base 模式）逐个加密给房间里的其他成员；
// - 安全码（8 个 emoji）：所有人看到的相同，就说明大家看到的成员列表一致；
// - 聊天：用发送者媒体密钥派生的聊天密钥加密正文，图片每张随机一把密钥（见 proto 的 EncryptedChat）。
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { uidOf } from './identity';

export const KEY_PACKAGE_INFO = 'OpenHane-E2EE-KeyPackage-v1';
const E2EE_KEY_CONTEXT = 'OpenHane-E2EE-Key-v1';
const SAFETY_CONTEXT = 'OpenHane-SafetyCode-v2';
/** 安全码 PBKDF2 的迭代次数：让「生成假成员的密钥、凑出相同的安全码」的每次尝试都很慢 */
export const SAFETY_ITERATIONS = 1 << 20;
/** 安全码的 emoji 个数（每个 6 位，是 SAFETY_EMOJI 里的序号） */
export const SAFETY_LENGTH = 8;

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

export const CHAT_CONTEXT = 'OpenHane-Chat-v1';
export const CHAT_IMAGE_CONTEXT = 'OpenHane-ChatImage-v1';
/** 加密图片文件的开头（后面是 12 字节 nonce 和 AES-256-GCM 密文） */
export const CHAT_IMAGE_MAGIC = 'HNE1';

/** 聊天密钥：HKDF-SHA256(ikm = 媒体密钥, salt = "OpenHane-Chat-v1", info = 空) → AES-256-GCM 密钥 */
export async function chatKey(mediaKey: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', mediaKey as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(CHAT_CONTEXT), info: new Uint8Array() },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 聊天密文的 AAD："OpenHane-Chat-v1" ‖ 0x00 ‖ room_id ‖ 0x00 ‖ 发送者 session_id ‖ 0x00 ‖ key_index（4 字节大端） */
export function chatAAD(roomId: string, from: string, keyIndex: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, keyIndex);
  return concat(enc.encode(`${CHAT_CONTEXT}\0${roomId}\0${from}\0`), idx);
}

/** 加密聊天内容（ChatPlaintext 的编码）。nonce 不传时随机生成 */
export async function sealChat(key: CryptoKey, aad: Uint8Array, plaintext: Uint8Array, nonce = crypto.getRandomValues(new Uint8Array(12))) {
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource }, key, plaintext as BufferSource);
  return { nonce, ciphertext: new Uint8Array(ct) };
}

/** 解密聊天内容；密钥不对、被篡改或 AAD 不符时抛出异常 */
export async function openChat(key: CryptoKey, aad: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource }, key, ciphertext as BufferSource));
}

const imageKey = (raw: Uint8Array, usage: KeyUsage) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [usage]);

/**
 * 加密一张图片：每张图片随机一把密钥，文件 = "HNE1" ‖ nonce ‖ AES-256-GCM(key, nonce, 图片, aad = "OpenHane-ChatImage-v1")。
 * 返回要上传的文件、密钥和文件的 SHA-256（密钥和摘要放进加密的聊天正文里）
 */
export async function sealChatImage(image: Uint8Array, key = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12))) {
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: enc.encode(CHAT_IMAGE_CONTEXT) }, await imageKey(key, 'encrypt'), image as BufferSource);
  const file = concat(enc.encode(CHAT_IMAGE_MAGIC), nonce, new Uint8Array(ct));
  return { file, key, digest: new Uint8Array(await crypto.subtle.digest('SHA-256', file as BufferSource)) };
}

/** 解密下载的图片：先核对摘要（服务器换不了文件），再解密 */
export async function openChatImage(file: Uint8Array, key: Uint8Array, digest: Uint8Array): Promise<Uint8Array> {
  const got = new Uint8Array(await crypto.subtle.digest('SHA-256', file as BufferSource));
  if (got.length !== digest.length || got.some((b, i) => b !== digest[i])) throw new Error('image digest mismatch');
  const head = CHAT_IMAGE_MAGIC.length;
  if (file.length <= head + 12 + 16 || new TextDecoder().decode(file.subarray(0, head)) !== CHAT_IMAGE_MAGIC) throw new Error('not an encrypted image');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: file.subarray(head, head + 12) as BufferSource, additionalData: enc.encode(CHAT_IMAGE_CONTEXT) },
    await imageKey(key, 'decrypt'),
    file.subarray(head + 12) as BufferSource,
  );
  return new Uint8Array(pt);
}

/** 安全码的输入：SHA-256("OpenHane-SafetyCode-v2" ‖ 0x00 ‖ 按 UID 排序、去重后的 UID ‖ 0x00 ‖ 身份公钥…)。计算很快，可以用来判断成员是否变了 */
export async function safetyDigest(members: { uid: string; publicKey: Uint8Array }[]): Promise<Uint8Array> {
  const byUid = new Map(members.map((m) => [m.uid, m.publicKey]));
  const uids = [...byUid.keys()].sort();
  const parts: Uint8Array[] = [enc.encode(SAFETY_CONTEXT), new Uint8Array([0])];
  for (const u of uids) parts.push(enc.encode(u), new Uint8Array([0]), byUid.get(u)!);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts) as BufferSource));
}

/**
 * 由 safetyDigest 的结果算出安全码：PBKDF2-HMAC-SHA256(digest, salt = "OpenHane-SafetyCode-v2", 2^20 次) 取 48 位，
 * 从高到低每 6 位一组，得到 8 个 0–63 的 emoji 序号。要算零点几秒（不阻塞页面）
 */
export async function safetyCodeFromDigest(digest: Uint8Array): Promise<number[]> {
  const key = await crypto.subtle.importKey('raw', digest as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SAFETY_CONTEXT), iterations: SAFETY_ITERATIONS }, key, SAFETY_LENGTH * 6),
  );
  let v = 0n;
  for (const b of bits) v = (v << 8n) | BigInt(b);
  return Array.from({ length: SAFETY_LENGTH }, (_, i) => Number((v >> BigInt(6 * (SAFETY_LENGTH - 1 - i))) & 63n));
}

export async function safetyCode(members: { uid: string; publicKey: Uint8Array }[]): Promise<number[]> {
  return safetyCodeFromDigest(await safetyDigest(members));
}

/**
 * 安全码用的 64 个 emoji（与 Matrix 的 emoji 验证相同：在各平台上容易区分、好叫名字），名称在界面的翻译里（e2ee.emoji.<序号>）。
 * 与 testdata/e2ee/safety-emoji.json 一致
 */
export const SAFETY_EMOJI: readonly string[] = [
  '🐶', '🐱', '🦁', '🐎', '🦄', '🐷', '🐘', '🐰', '🐼', '🐓', '🐧', '🐢', '🐟', '🐙', '🦋', '🌷',
  '🌳', '🌵', '🍄', '🌏', '🌙', '☁️', '🔥', '🍌', '🍎', '🍓', '🌽', '🍕', '🎂', '❤️', '😀', '🤖',
  '🎩', '👓', '🔧', '🎅', '👍', '☂️', '⌛', '⏰', '🎁', '💡', '📕', '✏️', '📎', '✂️', '🔒', '🔑',
  '🔨', '☎️', '🏁', '🚂', '🚲', '✈️', '🚀', '🏆', '⚽', '🎸', '🎺', '🔔', '⚓', '🎧', '📁', '📌',
];
