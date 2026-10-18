import { create } from '@bufbuild/protobuf';
import { ParticipantSchema } from '@hane/protocol';
import { describe, expect, it } from 'vitest';
import { codecOptionLabel, decodeNote } from './codecNote';
import { translator } from './i18n';

const p = (nickname: string, hw: string[], sw: string[]) =>
  create(ParticipantSchema, { sessionId: nickname, nickname, decodeHardware: hw.map((c) => `video/${c}`), decodeSoftware: sw.map((c) => `video/${c}`) });
const t = translator('zh-CN');
const mac = p('Mac', ['h265', 'h264'], ['av1', 'vp8', 'vp9']);
const firefox = p('Firefox', [], ['av1', 'h264', 'vp8', 'vp9']);
const old = p('Old', [], []); // 旧版本客户端：没有上报，不计入

describe('codec notes', () => {
  it('option labels only carry the number of people affected', () => {
    expect(codecOptionLabel('h265', [mac, old], t)).toBe('H.265');
    expect(codecOptionLabel('h265', [mac, firefox], t)).toBe('H.265（1 人受影响）');
    expect(codecOptionLabel('av1', [mac, firefox], t)).toBe('AV1（2 人受影响）');
    expect(codecOptionLabel('av1', [mac, firefox], translator('en'))).toBe('AV1 (2 affected)');
  });
  it('the note below lists people who can only decode in software or cannot decode at all', () => {
    expect(decodeNote('h265', [mac, old], t)).toBe('');
    expect(decodeNote('av1', [mac, old], t)).toBe('Mac 不支持 AV1 硬件解码，会用软件解码（更费电，可能卡顿）');
    expect(decodeNote('h265', [mac, firefox], t)).toBe('Firefox 无法解码 H.265，会看 H.264 画面');
    expect(decodeNote('h264', [p('X', ['h265'], [])], t)).toBe('X 无法解码 H.264，看不到画面');
  });
  it('shortens long lists and combines both kinds', () => {
    const many = ['小王', '老李', 'C', 'D'].map((n) => p(n, [], ['av1', 'h264']));
    expect(decodeNote('av1', many, t)).toBe('小王、老李等 4 人不支持 AV1 硬件解码，会用软件解码（更费电，可能卡顿）');
    expect(decodeNote('h265', [many[0]!, p('M', ['h264'], ['h265'])], t)).toBe(
      '小王无法解码 H.265，会看 H.264 画面；M 不支持 H.265 硬件解码，会用软件解码（更费电，可能卡顿）',
    );
    expect(decodeNote('h265', many.slice(2), translator('en'))).toBe('C, D can’t decode H.265 and will see H.264');
  });
});
