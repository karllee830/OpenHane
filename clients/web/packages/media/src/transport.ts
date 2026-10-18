// 媒体传输：UDP 不稳定时改走 TCP—— 与 Swift 版 HaneCore/TransportMonitor.swift 一致。
// 运营商对 UDP 限速时，一有流量就大量丢包、延迟暴涨，WebRTC 只会不停降码率和分辨率；同一条线路走 TCP 往往完全正常。
// 判断由客户端做（发送和接收两个方向的丢包都看得到），切换用 LiveKit 的 ICE 重启（偏好 TCP），轨道保留。

export type TcpFallbackMode = 'auto' | 'off' | 'always';

/** 每次采样（约 2 秒一次）的媒体连接统计 */
export interface TransportSample {
  /** 当前选中的候选地址对的协议；还没连上时为 null */
  protocol: 'udp' | 'tcp' | null;
  /** 往返时间（毫秒），没有数据时为 null */
  rttMs: number | null;
  /** 上行丢包率（0–1，对方接收报告里的 fractionLost 取最大值），没有数据时为 null */
  lossUp: number | null;
  /** 下行丢包率（0–1，这段时间收到的包里丢了多少），没有数据时为 null */
  lossDown: number | null;
  /** 这段时间收到的包数（太少时不看下行丢包率） */
  packetsDown: number;
}

export const TRANSPORT = {
  /** 连上后先观察这么久再判断（带宽估计刚开始会波动） */
  warmupMs: 6000,
  /** 丢包率达到这个值算一次「差」 */
  loss: 0.05,
  /** 下行丢包率要在收到这么多包时才可信 */
  minPackets: 50,
  /** 往返时间同时超过这个值和最低值的 rttFactor 倍，算一次「差」 */
  rttMs: 300,
  rttFactor: 3,
  /** 最近 window 次里有 bad 次差就切换（每 2 秒一次，约 10 秒） */
  window: 5,
  bad: 4,
};

/** 判断什么时候该切到 TCP。update 返回 true 时调用方发起切换（只会返回一次） */
export class TransportMonitor {
  private history: boolean[] = [];
  private minRtt = Infinity;
  private switched = false;
  reason = '';

  constructor(
    private readonly mode: TcpFallbackMode,
    private readonly startedAt: number,
  ) {}

  update(now: number, s: TransportSample): boolean {
    if (this.switched || this.mode === 'off' || s.protocol !== 'udp') return false;
    if (this.mode === 'always') return this.fire('always');
    if (s.rttMs !== null && s.rttMs > 0) this.minRtt = Math.min(this.minRtt, s.rttMs);
    if (now - this.startedAt < TRANSPORT.warmupMs) return false;
    const lossy = (s.lossUp ?? 0) >= TRANSPORT.loss || (s.packetsDown >= TRANSPORT.minPackets && (s.lossDown ?? 0) >= TRANSPORT.loss);
    const slow = s.rttMs !== null && s.rttMs >= TRANSPORT.rttMs && s.rttMs >= this.minRtt * TRANSPORT.rttFactor;
    this.history.push(lossy || slow);
    if (this.history.length > TRANSPORT.window) this.history.shift();
    if (this.history.filter(Boolean).length >= TRANSPORT.bad) return this.fire(lossy ? 'loss' : 'rtt');
    return false;
  }

  private fire(reason: string): boolean {
    this.switched = true;
    this.reason = reason;
    return true;
  }
}

/** 从两个 PeerConnection 的统计里取一次采样。prev 记录上次的累计值（算这段时间的下行丢包） */
export function sampleTransport(reports: RTCStatsReport[], prev: { lost: number; received: number }): TransportSample {
  // 每条连接的协议；只看真正在传媒体的连接（只看不发的人，发送那条连接空着，可能一直停在 UDP 上）
  const active: ('udp' | 'tcp')[] = [];
  const idle: ('udp' | 'tcp')[] = [];
  let rttMs: number | null = null;
  let lossUp: number | null = null;
  let lost = 0;
  let received = 0;
  for (const report of reports) {
    let proto: 'udp' | 'tcp' | null = null;
    let carriesMedia = false;
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        const local = report.get(String(s.localCandidateId)) as { protocol?: string } | undefined;
        if (local?.protocol === 'udp' || local?.protocol === 'tcp') proto = local.protocol;
        if (typeof s.currentRoundTripTime === 'number') rttMs = Math.max(rttMs ?? 0, s.currentRoundTripTime * 1000);
      }
      if (s.type === 'remote-inbound-rtp' && typeof s.fractionLost === 'number') lossUp = Math.max(lossUp ?? 0, s.fractionLost);
      if (s.type === 'outbound-rtp' && Number(s.packetsSent ?? 0) > 0) carriesMedia = true;
      if (s.type === 'inbound-rtp') {
        lost += Math.max(0, Number(s.packetsLost ?? 0));
        received += Number(s.packetsReceived ?? 0);
        if (Number(s.packetsReceived ?? 0) > 0) carriesMedia = true;
      }
    });
    if (proto) (carriesMedia ? active : idle).push(proto);
  }
  // 发送和接收各一条连接，可能一条走 TCP、另一条还在 UDP：只要有一条在传媒体的连接走 UDP 就按 UDP 判断
  const list = active.length ? active : idle;
  const protocol = list.includes('udp') ? 'udp' : list.length ? 'tcp' : null;
  const dLost = Math.max(0, lost - prev.lost);
  const dReceived = Math.max(0, received - prev.received);
  prev.lost = lost;
  prev.received = received;
  return { protocol, rttMs, lossUp, lossDown: dLost + dReceived > 0 ? dLost / (dLost + dReceived) : null, packetsDown: dReceived };
}
