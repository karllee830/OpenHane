import { describe, expect, it } from 'vitest';
import { isSafePng, logoUrl, readLimited } from './probe';

/** 只有文件头的 PNG：签名 + IHDR（宽、高） */
function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

describe('untrusted server data', () => {
  it('accepts only PNGs of a sane size', () => {
    expect(isSafePng(pngHeader(512, 512))).toBe(true);
    expect(isSafePng(pngHeader(1024, 1024))).toBe(true);
    // 解压炸弹：声称几万像素
    expect(isSafePng(pngHeader(50000, 50000))).toBe(false);
    expect(isSafePng(pngHeader(0, 512))).toBe(false);
    // 其他格式（JPEG、SVG、随便什么）一律不要
    expect(isSafePng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(30).fill(0)]))).toBe(false);
    expect(isSafePng(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe(false);
    const noIhdr = pngHeader(512, 512);
    noIhdr[12] = 0x74; // 第一个块不是 IHDR
    expect(isSafePng(noIhdr)).toBe(false);
  });

  it('builds the logo URL only from a hex digest', () => {
    const info = 'https://meet.example.com:9800/api/v1/info';
    expect(logoUrl('16b8097ffe033265', info)).toBe('https://meet.example.com:9800/api/v1/logo?v=16b8097ffe033265');
    for (const bad of ['', '//evil.example.com/x', '../../etc', 'abc', 'ABCDEF0123456789', 42, null]) expect(logoUrl(bad, info)).toBeUndefined();
  });

  it('stops reading once the limit is exceeded', async () => {
    let pulled = 0;
    // 无限的响应：一直给数据
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(16 << 10));
      },
    });
    await expect(readLimited(new Response(endless), 64 << 10)).rejects.toThrow('too large');
    expect(pulled).toBeLessThan(10);
    await expect(readLimited(new Response('x'.repeat(100), { headers: { 'content-length': '100' } }), 50)).rejects.toThrow('too large');
    expect(new TextDecoder().decode(await readLimited(new Response('{"online":3}'), 64))).toBe('{"online":3}');
  });
});
