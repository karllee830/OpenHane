import { describe, expect, it } from 'vitest';
import { chatImageErrorCode, isImageId, isRoomId, sniffImage, validSize } from './images';

function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

describe('chat images', () => {
  it('sniffs PNG and JPEG by their headers only', () => {
    expect(sniffImage(pngHeader(100, 50))).toBe('image/png');
    expect(sniffImage(pngHeader(9000, 50))).toBeNull();
    expect(sniffImage(pngHeader(0, 50))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBeNull();
  });

  it('validates ids and sizes from the server', () => {
    expect(isImageId('0123456789abcdefghjkmnpqrs')).toBe(true);
    expect(isImageId('../../etc/passwd')).toBe(false);
    expect(isImageId('0123456789ABCDEFGHJKMNPQRS')).toBe(false);
    expect(isRoomId('main')).toBe(true);
    expect(isRoomId('r_abc')).toBe(true);
    expect(isRoomId('a/b')).toBe(false);
    expect(validSize(4096, 82)).toBe(true);
    expect(validSize(0, 10)).toBe(false);
    expect(validSize(1.5, 10)).toBe(false);
    expect(validSize(10, 100000)).toBe(false);
  });

  it('maps only known error codes', () => {
    expect(chatImageErrorCode('storage_full')).toBe('storage_full');
    expect(chatImageErrorCode('<script>')).toBe('failed');
    expect(chatImageErrorCode(undefined)).toBe('failed');
  });
});
