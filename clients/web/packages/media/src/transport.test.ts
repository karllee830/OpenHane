import { describe, expect, it } from 'vitest';
import { TransportMonitor, sampleTransport, type TransportSample } from './transport';

const good: TransportSample = { protocol: 'udp', rttMs: 25, lossUp: 0, lossDown: 0, packetsDown: 500 };
const run = (m: TransportMonitor, samples: TransportSample[], from = 6000) => samples.map((s, i) => m.update(from + i * 2000, s));

describe('TransportMonitor', () => {
  it('switches after sustained UDP loss (4 of the last 5 samples), only once', () => {
    const m = new TransportMonitor('auto', 0);
    run(m, [good], 0);
    const lossy = { ...good, lossUp: 0.12 };
    expect(run(m, [lossy, lossy, good, lossy])).toEqual([false, false, false, false]);
    expect(m.update(20000, lossy)).toBe(true);
    expect(m.reason).toBe('loss');
    expect(m.update(22000, lossy)).toBe(false);
  });
  it('counts download loss only with enough packets', () => {
    const m = new TransportMonitor('auto', 0);
    const fewPackets = { ...good, lossDown: 0.5, packetsDown: 10 };
    expect(run(m, [fewPackets, fewPackets, fewPackets, fewPackets, fewPackets]).some(Boolean)).toBe(false);
    const downLoss = { ...good, lossDown: 0.08, packetsDown: 300 };
    expect(run(m, [downLoss, downLoss, downLoss, downLoss], 20000).at(-1)).toBe(true);
  });
  it('switches when the round-trip time balloons (queueing on a throttled UDP path)', () => {
    const m = new TransportMonitor('auto', 0);
    run(m, [good, good], 0);
    const slow = { ...good, rttMs: 900 };
    expect(run(m, [slow, slow, slow, slow]).at(-1)).toBe(true);
    expect(m.reason).toBe('rtt');
    // 本来就远的服务器（基线 280 ms，偶尔 400 ms）不算
    const far = new TransportMonitor('auto', 0);
    run(far, [{ ...good, rttMs: 280 }], 0);
    expect(run(far, Array(6).fill({ ...good, rttMs: 400 })).some(Boolean)).toBe(false);
  });
  it('ignores the warm-up period, TCP connections and the off mode', () => {
    const lossy = { ...good, lossUp: 0.3 };
    expect(run(new TransportMonitor('auto', 0), Array(3).fill(lossy), 0).some(Boolean)).toBe(false);
    expect(run(new TransportMonitor('auto', 0), Array(6).fill({ ...lossy, protocol: 'tcp' })).some(Boolean)).toBe(false);
    expect(run(new TransportMonitor('off', 0), Array(6).fill(lossy)).some(Boolean)).toBe(false);
  });
  it('always mode switches as soon as it sees UDP', () => {
    const m = new TransportMonitor('always', 0);
    expect(m.update(0, { ...good, protocol: null })).toBe(false);
    expect(m.update(500, good)).toBe(true);
    expect(m.reason).toBe('always');
  });
  it('treats the connection as UDP while either peer connection still uses UDP', () => {
    const pc = (protocol: string, extra: Record<string, unknown>[] = []) =>
      new Map<string, Record<string, unknown>>([
        ['p', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', currentRoundTripTime: 0.02 }],
        ['l', { type: 'local-candidate', protocol }],
        ...extra.map((e, i) => [`x${i}`, e] as [string, Record<string, unknown>]),
      ]) as unknown as RTCStatsReport;
    const prev = { lost: 0, received: 0 };
    // 发送那条已经是 TCP，接收那条还在 UDP 上丢包：按 UDP 判断，下行丢包照常统计
    const s = sampleTransport([pc('tcp'), pc('udp', [{ type: 'inbound-rtp', packetsLost: 10, packetsReceived: 190 }])], prev);
    expect(s.protocol).toBe('udp');
    expect(s.lossDown).toBeCloseTo(0.05);
    expect(sampleTransport([pc('tcp'), pc('tcp')], prev).protocol).toBe('tcp');
    // 只看不发：发送那条连接空着停在 UDP，接收那条已经是 TCP → 按 TCP
    expect(sampleTransport([pc('udp'), pc('tcp', [{ type: 'inbound-rtp', packetsLost: 0, packetsReceived: 300 }])], prev).protocol).toBe('tcp');
  });
});
