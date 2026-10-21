import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChatPlaintextSchema, fromBinary } from '@hane/protocol';
import { describe, expect, it } from 'vitest';
import { deriveIdentity, sign } from './identity';
import {
  e2eeKeySigInput,
  generateKeyExchange,
  importKeyExchangePrivate,
  keyPackageAAD,
  newMediaKey,
  openKeyPackage,
  SAFETY_EMOJI,
  chatAAD,
  chatKey,
  openChat,
  openChatImage,
  sealChat,
  sealChatImage,
  safetyCode,
  sealKeyPackage,
  verifyE2EEKey,
} from './e2ee';

const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../testdata/e2ee/vectors.json'), 'utf8'));
const safetyEmoji = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../testdata/e2ee/safety-emoji.json'), 'utf8'));
const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('E2EE（与 Go 参考实现、Swift 共用的测试向量）', () => {
  it('opens key packages sealed by the Go reference implementation', async () => {
    for (const c of vectors.hpke) {
      const aad = keyPackageAAD(c.roomId, c.fromSessionId, c.toSessionId, c.keyIndex);
      expect(toHex(aad)).toBe(c.aad);
      const sk = await importKeyExchangePrivate(hex(c.recipientPrivateKey));
      expect(toHex(await openKeyPackage(sk, hex(c.enc), hex(c.ciphertext), aad))).toBe(c.plaintext);
      // 换了接收者（AAD 不符）就解不开
      await expect(openKeyPackage(sk, hex(c.enc), hex(c.ciphertext), keyPackageAAD(c.roomId, c.fromSessionId, 'other', c.keyIndex))).rejects.toThrow();
    }
  });

  it('seals and opens its own key packages', async () => {
    const kx = await generateKeyExchange();
    const key = newMediaKey();
    const aad = keyPackageAAD('r_1', 'a', 'b', 3);
    const { enc, ciphertext } = await sealKeyPackage(kx.publicKey, aad, key);
    expect(enc.length).toBe(32);
    expect(toHex(await openKeyPackage(kx.privateKey, enc, ciphertext, aad))).toBe(toHex(key));
    const other = await generateKeyExchange();
    await expect(openKeyPackage(other.privateKey, enc, ciphertext, aad)).rejects.toThrow();
  });

  it('computes the same safety code', async () => {
    for (const c of vectors.safetyCode) {
      expect(await safetyCode(c.members.map((m: { uid: string; publicKey: string }) => ({ uid: m.uid, publicKey: hex(m.publicKey) })))).toEqual(c.code);
    }
  });

  it('encrypts chat like the Go reference implementation', async () => {
    for (const c of vectors.chat) {
      const key = await chatKey(hex(c.mediaKey));
      const aad = chatAAD(c.roomId, c.fromSessionId, c.keyIndex);
      expect(toHex(aad)).toBe(c.aad);
      expect(toHex((await sealChat(key, aad, hex(c.plaintext), hex(c.nonce))).ciphertext)).toBe(c.ciphertext);
      expect(toHex(await openChat(key, aad, hex(c.nonce), hex(c.ciphertext)))).toBe(c.plaintext);
      expect(fromBinary(ChatPlaintextSchema, hex(c.plaintext)).text).toBe(c.text);
      // 换了发送者或密钥索引（AAD 不符）就解不开
      await expect(openChat(key, chatAAD(c.roomId, 'other', c.keyIndex), hex(c.nonce), hex(c.ciphertext))).rejects.toThrow();
    }
  });

  it('encrypts chat images like the Go reference implementation', async () => {
    for (const c of vectors.chatImage) {
      const sealed = await sealChatImage(hex(c.image), hex(c.key), hex(c.nonce));
      expect([toHex(sealed.file), toHex(sealed.digest)]).toEqual([c.file, c.digest]);
      expect(toHex(await openChatImage(hex(c.file), hex(c.key), hex(c.digest)))).toBe(c.image);
      // 服务器换了文件：摘要对不上
      const other = hex(c.file);
      other[other.length - 1]! ^= 1;
      await expect(openChatImage(other, hex(c.key), hex(c.digest))).rejects.toThrow();
    }
  });

  it('uses the shared emoji table', () => {
    expect(SAFETY_EMOJI).toEqual(safetyEmoji.map((e: { emoji: string }) => e.emoji));
  });

  it('verifies E2EE key signatures and rejects keys that do not belong to the UID', async () => {
    const id = await deriveIdentity(new Uint8Array(32), new TextEncoder().encode('server-a-16bytes'));
    const kx = await generateKeyExchange();
    const sig = await sign(id.privateKey, e2eeKeySigInput(kx.publicKey));
    expect(await verifyE2EEKey(id.uid, id.publicKey, kx.publicKey, sig)).toBe(true);
    const forged = (await generateKeyExchange()).publicKey;
    expect(await verifyE2EEKey(id.uid, id.publicKey, forged, sig)).toBe(false);
    expect(await verifyE2EEKey('aaaaaaaaaaaaaaaaaaaa', id.publicKey, kx.publicKey, sig)).toBe(false);
  });
});
