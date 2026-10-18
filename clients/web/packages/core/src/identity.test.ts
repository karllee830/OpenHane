import { describe, expect, it } from 'vitest';
import { authSigInput, deriveIdentity, shortUid, toHex, uidOf } from './identity';

describe('identity', () => {
  it('matches the server-side derivation vector', async () => {
    // 与 server/internal/identity 的固定向量一致（已用 Python HKDF + OpenSSL 独立核对）
    const id = await deriveIdentity(new Uint8Array(32), new TextEncoder().encode('server-a-16bytes'));
    expect(id.uid).toBe('2gqiydvtufme24hxgoyk');
    expect(shortUid(id.uid)).toBe('2gqi-ydvt');
  });

  it('computes UID of the zero-seed public key', async () => {
    const pub = Uint8Array.from('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29'.match(/../g)!, (h) => parseInt(h, 16));
    expect(await uidOf(pub)).toBe('copdsqhgjnkjc4rardm2');
  });

  it('builds the auth signature input byte-for-byte', () => {
    const input = authSigInput(new Uint8Array(16).fill(0x11), new Uint8Array(32).fill(0x22), new Uint8Array(32).fill(0x33), 0x0102030405060708n);
    const want =
      toHex(new TextEncoder().encode('OpenHane-Auth-v1')) + '00' + '11'.repeat(16) + '22'.repeat(32) + '33'.repeat(32) + '0102030405060708';
    expect(toHex(input)).toBe(want);
  });
});
