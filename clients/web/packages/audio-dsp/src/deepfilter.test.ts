import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DFN_FRAME, DeepFilter, lsnrToVad } from './deepfilter';
import { rmsDb } from './gate';

const dir = fileURLToPath(new URL('../dfn/', import.meta.url));
const built = existsSync(dir + 'hane-deepfilter.wasm') && existsSync(dir + 'deepfilternet3.bin');
// CI 先运行 clients/deepfilter/build.sh web，并设置 HANE_REQUIRE_DFN=1：没有 WASM 时测试失败而不是跳过
const required = process.env.HANE_REQUIRE_DFN === '1';

describe('lsnrToVad', () => {
  it('maps 0 dB to 0.5, is monotonic, and treats NaN as unknown', () => {
    expect(lsnrToVad(0)).toBeCloseTo(0.5);
    expect(lsnrToVad(-15)!).toBeLessThan(0.01);
    expect(lsnrToVad(10)!).toBeGreaterThan(0.95);
    expect(lsnrToVad(3)!).toBeGreaterThan(lsnrToVad(2)!);
    expect(lsnrToVad(NaN)).toBeNull();
  });
});

describe.skipIf(!built && !required)('DeepFilter (WASM)', () => {
  const load = () => new DeepFilter(new WebAssembly.Module(readFileSync(dir + 'hane-deepfilter.wasm')), readFileSync(dir + 'deepfilternet3.bin'));
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

  it('removes steady noise, reports a low local SNR, and stays stable', () => {
    const df = load();
    const frame = new Float32Array(DFN_FRAME);
    const levels: number[] = [];
    const lsnrs: number[] = [];
    for (let f = 0; f < 300; f++) {
      for (let i = 0; i < DFN_FRAME; i++) frame[i] = rand() * 0.05; // 约 -31 dBFS 的白噪声
      const lsnr = df.process(frame);
      if (f >= 100) {
        levels.push(rmsDb(frame));
        lsnrs.push(lsnr);
      }
      expect(frame.every(Number.isFinite)).toBe(true);
    }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(levels)).toBeLessThan(-31 - 25); // 至少压低 25 dB
    expect(avg(lsnrs)).toBeLessThan(0); // 门控不会把纯噪声当成人声
    df.destroy();
  });

  it('keeps digital silence silent', () => {
    const df = load();
    const frame = new Float32Array(DFN_FRAME);
    for (let f = 0; f < 50; f++) {
      frame.fill(0);
      df.process(frame);
    }
    expect(Math.max(...frame.map(Math.abs))).toBe(0);
    df.destroy();
  });
});
