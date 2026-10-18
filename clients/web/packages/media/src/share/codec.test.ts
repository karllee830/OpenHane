import { describe, expect, it } from 'vitest';
import { chooseShareCodec, selectableShareCodecs, type EncodeCaps } from './codec';

const caps = (...c: [EncodeCaps['codecs'][number]['codec'], boolean][]): EncodeCaps => ({ codecs: c.map(([codec, hardware]) => ({ codec, hardware })) });
// 带 AV1 硬件编码器的 PC、Apple 芯片的 Mac（Chrome：没有 AV1 硬件，1440p 的 H.264 不是能效高的实现）、只有软件编码的机器
const av1Pc = caps(['av1', true], ['h265', true], ['h264', true]);
const mac = caps(['av1', false], ['h265', true], ['h264', false]);
const softOnly = caps(['av1', false], ['h264', false]);
const all = ['video/av1', 'video/h264', 'video/h265', 'video/vp8', 'video/vp9'];
const pick = (c: EncodeCaps, o: { decodable?: string[]; policy?: 'auto' | 'compat'; e2ee?: boolean; prefer?: 'av1' | 'h265' | 'h264' } = {}) =>
  chooseShareCodec({ caps: c, roomDecodable: o.decodable ?? all, policy: o.policy ?? 'auto', e2ee: o.e2ee ?? false, prefer: o.prefer });

describe('chooseShareCodec', () => {
  it('prefers hardware AV1, then hardware H.265, then hardware H.264, with H.264 backup', () => {
    expect(pick(av1Pc)).toEqual({ codec: 'av1', backup: 'h264' });
    expect(pick(mac)).toEqual({ codec: 'h265', backup: 'h264' });
    expect(pick(caps(['h265', false], ['h264', true]))).toEqual({ codec: 'h264', backup: undefined });
  });
  it('never uses software AV1 / H.265: software encoding is H.264 only', () => {
    expect(pick(softOnly)).toEqual({ codec: 'h264', backup: undefined });
    expect(pick(caps(['av1', false], ['h265', false], ['h264', false]))).toEqual({ codec: 'h264', backup: undefined });
  });
  it('respects what the room can decode', () => {
    expect(pick(av1Pc, { decodable: ['video/h264', 'video/h265', 'video/vp8'] })?.codec).toBe('h265');
    expect(pick(mac, { decodable: ['video/av1', 'video/h264', 'video/vp8'] })).toEqual({ codec: 'h264', backup: undefined });
    // 有人连 H.264 都解不了：仍发 H.264（这个人看不到），不改用软件 VP8
    expect(pick(mac, { decodable: ['video/vp8'] })).toEqual({ codec: 'h264', backup: undefined });
  });
  it('never picks AV1 in E2EE rooms (LiveKit frame encryption does not support it)', () => {
    expect(pick(av1Pc, { e2ee: true })?.codec).toBe('h265');
    expect(pick(mac, { e2ee: true })?.codec).toBe('h265');
  });
  it('compat policy: H.264 only', () => {
    expect(pick(av1Pc, { policy: 'compat' })).toEqual({ codec: 'h264', backup: undefined });
    expect(pick(mac, { policy: 'compat' })).toEqual({ codec: 'h264', backup: undefined });
  });
  it('cannot share without any usable encoder (no H.264 at all)', () => {
    expect(pick(caps(['av1', false]))).toBeNull();
    expect(pick(caps(['av1', true]), { e2ee: true })).toBeNull();
  });
  it('custom: only hardware codecs are selectable (no AV1 in E2EE rooms, none with compat)', () => {
    expect(selectableShareCodecs(av1Pc, { policy: 'auto', e2ee: false })).toEqual(['av1', 'h265', 'h264']);
    expect(selectableShareCodecs(mac, { policy: 'auto', e2ee: false })).toEqual(['h265']);
    expect(selectableShareCodecs(softOnly, { policy: 'auto', e2ee: false })).toEqual([]);
    expect(selectableShareCodecs(av1Pc, { policy: 'auto', e2ee: true })).toEqual(['h265', 'h264']);
    expect(selectableShareCodecs(av1Pc, { policy: 'compat', e2ee: false })).toEqual([]);
  });
  it('custom: the chosen hardware codec wins, even if someone in the room cannot decode it (they get the H.264 backup)', () => {
    expect(pick(av1Pc, { prefer: 'h264' })).toEqual({ codec: 'h264', backup: undefined });
    expect(pick(av1Pc, { prefer: 'h265', decodable: ['video/h264', 'video/vp8'] })).toEqual({ codec: 'h265', backup: 'h264' });
    expect(pick(mac, { prefer: 'h265' })).toEqual({ codec: 'h265', backup: 'h264' });
  });
  it('custom: a choice that is not available falls back to automatic', () => {
    expect(pick(mac, { prefer: 'av1' })).toEqual({ codec: 'h265', backup: 'h264' }); // 没有 AV1 硬件
    expect(pick(mac, { prefer: 'h264' })).toEqual({ codec: 'h265', backup: 'h264' }); // H.264 只有软件
    expect(pick(av1Pc, { prefer: 'av1', e2ee: true })?.codec).toBe('h265');
    expect(pick(av1Pc, { prefer: 'h265', policy: 'compat' })).toEqual({ codec: 'h264', backup: undefined });
  });
});
