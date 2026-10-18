import { describe, expect, it } from 'vitest';
import { Gate, rmsDb } from './gate';

const run = (g: Gate, frames: number, level: number, vad: number | null = null) => {
  let open = false;
  for (let i = 0; i < frames; i++) open = g.update(level, vad);
  return open;
};

describe('Gate', () => {
  it('voice activation opens on speech and holds 300 ms', () => {
    const g = new Gate({ mode: 'voice', threshold: 'auto' });
    expect(run(g, 100, -70)).toBe(false); // 安静：学习噪声底
    expect(g.noiseFloorDb).toBeLessThan(-65);
    expect(g.update(-30, null)).toBe(true); // 一帧就打开（< 10 ms）
    expect(run(g, 29, -70)).toBe(true); // 保持 290 ms
    expect(run(g, 1, -70)).toBe(false); // 300 ms 后关闭
  });

  it('uses RNNoise VAD when available', () => {
    const g = new Gate({ mode: 'voice', threshold: 'auto' });
    run(g, 100, -60, 0.01);
    expect(g.update(-35, 0.05)).toBe(false); // 很响但不是人声（键盘、风扇）
    expect(g.update(-35, 0.9)).toBe(true);
  });

  it('adapts to a noisy room', () => {
    const g = new Gate({ mode: 'voice', threshold: 'auto' });
    run(g, 500, -45); // 持续噪声
    expect(g.thresholdDb()).toBeGreaterThan(-40);
    expect(g.update(-44, null)).toBe(false);
  });

  it('push to talk with 200 ms release', () => {
    const g = new Gate({ mode: 'ptt', threshold: 'auto' });
    expect(g.update(-20, null)).toBe(false); // 没按键，说话也不打开
    g.pttPressed = true;
    expect(g.update(-80, null)).toBe(true);
    g.pttPressed = false;
    expect(run(g, 19, -20)).toBe(true);
    expect(run(g, 1, -20)).toBe(false);
  });

  it('manual threshold and open mode', () => {
    const g = new Gate({ mode: 'voice', threshold: -40 });
    expect(g.update(-45, null)).toBe(false);
    expect(g.update(-35, null)).toBe(true);
    expect(new Gate({ mode: 'open', threshold: 'auto' }).update(-100, null)).toBe(true);
  });

  it('rmsDb', () => {
    expect(rmsDb(new Float32Array(480).fill(1))).toBeCloseTo(0, 3);
    expect(rmsDb(new Float32Array(480).fill(0.1))).toBeCloseTo(-20, 3);
  });
});
