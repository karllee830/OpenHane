import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAFFIC, TrafficPacer, TrafficPolicy, newTrafficCounters, sampleTraffic, type TrafficSample, type TrafficState } from './traffic';

// 与 Swift 版共用的测试向量。改了策略后重新生成：HANE_UPDATE_TRAFFIC=1 npx vitest run packages/media/src/traffic.test.ts
const FILE = resolve(import.meta.dirname, '../../../../../testdata/traffic/vectors.json');

interface Vector {
  name: string;
  samples: TrafficSample[];
  expected: TrafficState[];
}

const calm: Omit<TrafficSample, 't'> = {
  upRttMs: 40,
  upLoss: 0,
  cameraLimited: false,
  shareLimited: false,
  downLoss: 0,
  downPackets: 200,
  jitterBufferMs: 30,
  freezes: 0,
  upActive: true,
  downActive: true,
};

/** 每秒一个样本，第 i 个用 f(i) 覆盖平稳时的值 */
function scenario(n: number, f: (i: number) => Partial<TrafficSample> = () => ({})): TrafficSample[] {
  return Array.from({ length: n }, (_, i) => ({ ...calm, t: i * 1000, ...f(i) }));
}

const scenarios: { name: string; samples: TrafficSample[] }[] = [
  { name: '平稳：传输中逐步加速到上限', samples: scenario(40) },
  { name: '上行往返时间升高（排队）：图片减速，屏幕共享让路', samples: scenario(16, (i) => ({ upRttMs: i >= 5 && i < 10 ? 130 : 40 })) },
  { name: '往返时间小幅波动不算拥堵', samples: scenario(10, (i) => ({ upRttMs: 40 + (i % 3) * 25 })) },
  { name: '上行丢包', samples: scenario(10, (i) => ({ upLoss: i >= 4 && i < 7 ? 0.08 : 0.01 })) },
  { name: '摄像头受带宽限制：图片减速，屏幕共享让路', samples: scenario(10, (i) => ({ cameraLimited: i >= 3 && i < 6 })) },
  { name: '屏幕共享自己受带宽限制：图片减速，共享不让路', samples: scenario(10, (i) => ({ shareLimited: i >= 3 && i < 6 })) },
  { name: '下行丢包；包太少时不算', samples: scenario(12, (i) => ({ downLoss: i >= 3 && i < 9 ? 0.06 : 0, downPackets: i >= 6 && i < 9 ? 20 : 200 })) },
  { name: '下行抖动缓冲变长', samples: scenario(10, (i) => ({ jitterBufferMs: i >= 4 && i < 7 ? 120 : 30 })) },
  { name: '远端视频卡顿', samples: scenario(8, (i) => ({ freezes: i === 3 ? 1 : 0 })) },
  { name: '持续拥堵：速度降到下限', samples: scenario(14, () => ({ cameraLimited: true, jitterBufferMs: 200 })) },
  {
    name: '没有传输时不加速；空闲 10 秒后回到起始速度',
    samples: scenario(26, (i) => ({ upActive: i < 4 || i >= 20, downActive: i < 4, upRttMs: i === 6 ? 140 : 40 })),
  },
  { name: '没有媒体统计时不算拥堵', samples: scenario(6, () => ({ upRttMs: null, upLoss: null, downLoss: null, downPackets: 0, jitterBufferMs: null })) },
  { name: '基准只看最近 30 秒：链路变慢后成为新的基准', samples: scenario(45, (i) => ({ upRttMs: i < 3 ? 20 : 100 })) },
];

function run(samples: TrafficSample[]): TrafficState[] {
  const p = new TrafficPolicy();
  return samples.map((s) => p.update(s));
}

describe('TrafficPolicy（与 Swift 版共用的测试向量）', () => {
  if (process.env.HANE_UPDATE_TRAFFIC === '1') {
    const vectors: Vector[] = scenarios.map((s) => ({ ...s, expected: run(s.samples) }));
    writeFileSync(FILE, JSON.stringify({ version: 1, vectors }, null, 2) + '\n');
  }
  const { vectors } = JSON.parse(readFileSync(FILE, 'utf8')) as { vectors: Vector[] };

  it('covers every scenario', () => {
    expect(vectors.map((v) => v.name)).toEqual(scenarios.map((s) => s.name));
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(run(v.samples)).toEqual(v.expected);
  });

  it('behaves as described', () => {
    const steady = run(scenario(40));
    expect(steady.at(-1)!.upBps).toBe(TRAFFIC.maxBps);
    expect(steady.every((s) => !s.upCongested && !s.downCongested && !s.shareYield)).toBe(true);
    const queued = run(scenario(8, (i) => ({ upRttMs: i >= 5 ? 130 : 40 })));
    expect(queued[5]).toMatchObject({ upCongested: true, shareYield: true });
    expect(queued[5]!.upBps).toBe(Math.round(queued[4]!.upBps * TRAFFIC.decrease));
    const self = run(scenario(5, (i) => ({ shareLimited: i === 4 })));
    expect(self[4]).toMatchObject({ upCongested: true, shareYield: false });
  });
});

describe('TrafficPacer', () => {
  it('lets bytes through at the configured rate', async () => {
    let t = 0;
    const p = new TrafficPacer(() => t);
    p.set(100_000, 100_000);
    // 起始时能攒半秒的量
    await p.wait('up', 50_000);
    const started = Date.now();
    const pending = p.wait('up', 50_000);
    t += 500; // 半秒后又攒够了
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(p.takeActivity()).toEqual({ up: true, down: false });
    expect(p.takeActivity()).toEqual({ up: false, down: false });
    expect(p.chunkBytes('up')).toBe(50_000);
    p.set(1_000, 1_000);
    expect(p.chunkBytes('down')).toBe(16 << 10);
  });
});

describe('sampleTraffic', () => {
  const report = (...stats: Record<string, unknown>[]) => new Map(stats.map((s, i) => [String(i), s])) as unknown as RTCStatsReport;
  it('reads limitation, round-trip time, loss, jitter buffer and freezes', () => {
    const prev = newTrafficCounters();
    const inbound = (lost: number, received: number, delay: number, emitted: number, freezes: number) =>
      report(
        { type: 'inbound-rtp', kind: 'audio', packetsLost: lost, packetsReceived: received, jitterBufferDelay: delay, jitterBufferEmittedCount: emitted },
        { type: 'inbound-rtp', kind: 'video', packetsLost: 0, packetsReceived: 0, freezeCount: freezes },
      );
    sampleTraffic(0, { camera: [], share: [], down: [inbound(0, 100, 2, 100, 0)] }, prev);
    const s = sampleTraffic(
      1000,
      {
        camera: [report({ type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'bandwidth' }, { type: 'remote-inbound-rtp', roundTripTime: 0.05, fractionLost: 0.01 })],
        share: [report({ type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'none' }, { type: 'remote-inbound-rtp', roundTripTime: 0.12 })],
        down: [inbound(5, 195, 6, 200, 2)],
      },
      prev,
    );
    expect(s).toEqual({ t: 1000, upRttMs: 120, upLoss: 0.01, cameraLimited: true, shareLimited: false, downLoss: 0.05, downPackets: 95, jitterBufferMs: 40, freezes: 2 });
    // 轨道换了（累计值变小）：这一次没有下行数据
    const r = sampleTraffic(2000, { camera: [], share: [], down: [inbound(0, 10, 0.1, 10, 0)] }, prev);
    expect([r.downLoss, r.downPackets, r.jitterBufferMs, r.freezes]).toEqual([null, 0, null, 0]);
  });
});
