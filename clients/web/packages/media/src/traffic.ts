// 流量优先级：语音 > 摄像头 > 屏幕共享 > 聊天图片—— 与 Swift 版 HaneCore/TrafficPolicy.swift 一致，
// 共用 testdata/traffic/vectors.json。
//
// 不给图片设固定的带宽上限，而是让它只用媒体剩下的空闲带宽（类似 LEDBAT 这类低优先级后台传输）：
// 每秒看一次媒体的状况，出现拥堵的迹象（往返时间比平时高出一截＝开始排队、丢包、编码器受带宽限制、接收端抖动缓冲变长或卡顿）
// 就把图片的速度减半，一切正常时逐步加速（1.5 倍），网络空闲时照样能跑满。
// 屏幕共享在语音或摄像头吃紧时也让路（往返时间上升、丢包或摄像头受带宽限制时，共享引擎按更低的上行带宽调整）。

export const TRAFFIC = {
  /** 往返时间、抖动缓冲的基准取最近这么久的最低值 */
  baselineMs: 30_000,
  /** 往返时间比基准高出这么多：链路上开始排队了 */
  rttRiseMs: 60,
  /** 丢包率超过这个值算拥堵 */
  loss: 0.03,
  /** 下行丢包率要在收到这么多包时才可信 */
  minPackets: 50,
  /** 语音的抖动缓冲比基准长出这么多：下行在排队 */
  jitterRiseMs: 60,
  /** 图片传输的速度（字节/秒）：起始、下限、上限 */
  initialBps: 250_000,
  minBps: 4_000,
  maxBps: 125_000_000,
  /** 正常时每次乘以 increase，拥堵时乘以 decrease */
  increase: 1.5,
  decrease: 0.5,
  /** 这么久没有传输就回到起始速度（下次传输从头试探） */
  idleMs: 10_000,
};

/** 每秒一次的媒体状况 */
export interface TrafficSample {
  t: number;
  /** 上行：自己发出的语音和视频的往返时间（毫秒，对方接收报告里的最大值）和丢包率（0–1），没有数据时为 null */
  upRttMs: number | null;
  upLoss: number | null;
  /** 摄像头 / 屏幕共享的编码器受带宽限制 */
  cameraLimited: boolean;
  shareLimited: boolean;
  /** 下行：这段时间收到的包里丢了多少（0–1）和收到的包数 */
  downLoss: number | null;
  downPackets: number;
  /** 下行：远端语音的平均抖动缓冲延迟（毫秒），没有数据时为 null */
  jitterBufferMs: number | null;
  /** 下行：这段时间远端视频的卡顿次数 */
  freezes: number;
  /** 上次采样以来有没有在上传 / 下载图片（没在用时不加速） */
  upActive: boolean;
  downActive: boolean;
}

export interface TrafficState {
  upCongested: boolean;
  downCongested: boolean;
  /** 屏幕共享应当让路（语音或摄像头吃紧） */
  shareYield: boolean;
  /** 图片上传 / 下载当前允许的速度（字节/秒） */
  upBps: number;
  downBps: number;
}

/** 一段时间内的最低值 */
class WindowMin {
  private samples: { t: number; v: number }[] = [];
  update(t: number, v: number | null): number | null {
    if (v !== null) this.samples.push({ t, v });
    this.samples = this.samples.filter((s) => t - s.t < TRAFFIC.baselineMs);
    return this.samples.length ? Math.min(...this.samples.map((s) => s.v)) : null;
  }
}

class Lane {
  bps = TRAFFIC.initialBps;
  private lastActive = -Infinity;

  update(t: number, congested: boolean, active: boolean): number {
    if (active) this.lastActive = t;
    if (congested) this.bps = Math.max(TRAFFIC.minBps, Math.round(this.bps * TRAFFIC.decrease));
    else if (active) this.bps = Math.min(TRAFFIC.maxBps, Math.round(this.bps * TRAFFIC.increase));
    else if (t - this.lastActive >= TRAFFIC.idleMs) this.bps = TRAFFIC.initialBps;
    return this.bps;
  }
}

export class TrafficPolicy {
  private rtt = new WindowMin();
  private jitter = new WindowMin();
  private up = new Lane();
  private down = new Lane();

  update(s: TrafficSample): TrafficState {
    const minRtt = this.rtt.update(s.t, s.upRttMs);
    const minJitter = this.jitter.update(s.t, s.jitterBufferMs);
    const queued = s.upRttMs !== null && minRtt !== null && s.upRttMs - minRtt > TRAFFIC.rttRiseMs;
    const lossyUp = (s.upLoss ?? 0) > TRAFFIC.loss;
    const shareYield = queued || lossyUp || s.cameraLimited;
    const upCongested = shareYield || s.shareLimited;
    const lossyDown = s.downPackets >= TRAFFIC.minPackets && (s.downLoss ?? 0) > TRAFFIC.loss;
    const jitterUp = s.jitterBufferMs !== null && minJitter !== null && s.jitterBufferMs - minJitter > TRAFFIC.jitterRiseMs;
    const downCongested = lossyDown || jitterUp || s.freezes > 0;
    return {
      upCongested,
      downCongested,
      shareYield,
      upBps: this.up.update(s.t, upCongested, s.upActive),
      downBps: this.down.update(s.t, downCongested, s.downActive),
    };
  }
}

export type Direction = 'up' | 'down';

/**
 * 按 TrafficPolicy 给出的速度控制图片传输（令牌桶）。实现 @hane/core 的 TransferPacer：
 * 客户端每传一块之前调用 wait，块的大小按当前速度取约半秒的量
 */
export class TrafficPacer {
  private lanes = {
    up: { bps: TRAFFIC.initialBps, tokens: 0, at: -Infinity, used: false },
    down: { bps: TRAFFIC.initialBps, tokens: 0, at: -Infinity, used: false },
  };

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** 采样后更新速度 */
  set(up: number, down: number) {
    this.lanes.up.bps = up;
    this.lanes.down.bps = down;
  }

  /** 上次调用以来有没有传输（交给 TrafficPolicy 判断是否加速），并清除标记 */
  takeActivity(): { up: boolean; down: boolean } {
    const a = { up: this.lanes.up.used, down: this.lanes.down.used };
    this.lanes.up.used = this.lanes.down.used = false;
    return a;
  }

  chunkBytes(d: Direction): number {
    return Math.min(1 << 20, Math.max(16 << 10, Math.round(this.lanes[d].bps / 2)));
  }

  async wait(d: Direction, bytes: number, signal?: AbortSignal): Promise<void> {
    const lane = this.lanes[d];
    lane.used = true;
    for (;;) {
      signal?.throwIfAborted();
      const t = this.now();
      // 最多攒半秒的量：空闲之后不会一下子冲出去一大块
      lane.tokens = Math.min(lane.bps / 2, lane.tokens + ((t - lane.at) / 1000) * lane.bps);
      lane.at = t;
      // 一块比半秒的量还大时，攒满半秒就放行（否则永远等不到）
      if (lane.tokens >= Math.min(bytes, lane.bps / 2)) {
        lane.tokens -= bytes;
        return;
      }
      const ms = ((Math.min(bytes, lane.bps / 2) - lane.tokens) / lane.bps) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(5, ms))));
    }
  }
}

/** sampleTraffic 两次采样之间要记住的累计值 */
export interface TrafficCounters {
  lost: number;
  received: number;
  jitterDelay: number;
  jitterEmitted: number;
  freezes: number;
}

export const newTrafficCounters = (): TrafficCounters => ({ lost: 0, received: 0, jitterDelay: 0, jitterEmitted: 0, freezes: 0 });

/**
 * 从各个 PeerConnection 的统计里取一次 TrafficSample（活动标记由调用方填）。
 * camera：主连接的发送统计（摄像头）；share：共享连接的发送统计；down：两条连接的接收统计
 */
export function sampleTraffic(
  t: number,
  r: { camera: RTCStatsReport[]; share: RTCStatsReport[]; down: RTCStatsReport[] },
  prev: TrafficCounters,
): Omit<TrafficSample, 'upActive' | 'downActive'> {
  let upRttMs: number | null = null;
  let upLoss: number | null = null;
  const limited = (reports: RTCStatsReport[]) => {
    let lim = false;
    for (const report of reports) {
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video' && s.qualityLimitationReason === 'bandwidth') lim = true;
        if (s.type === 'remote-inbound-rtp') {
          if (typeof s.roundTripTime === 'number') upRttMs = Math.max(upRttMs ?? 0, s.roundTripTime * 1000);
          if (typeof s.fractionLost === 'number') upLoss = Math.max(upLoss ?? 0, s.fractionLost);
        }
      });
    }
    return lim;
  };
  const cameraLimited = limited(r.camera);
  const shareLimited = limited(r.share);
  const now = newTrafficCounters();
  for (const report of r.down) {
    report.forEach((s: Record<string, unknown>) => {
      if (s.type !== 'inbound-rtp') return;
      now.lost += Math.max(0, Number(s.packetsLost ?? 0));
      now.received += Number(s.packetsReceived ?? 0);
      if (s.kind === 'audio') {
        now.jitterDelay += Number(s.jitterBufferDelay ?? 0);
        now.jitterEmitted += Number(s.jitterBufferEmittedCount ?? 0);
      }
      if (s.kind === 'video') now.freezes += Number(s.freezeCount ?? 0);
    });
  }
  // 轨道换了时累计值会变小：这一次按没有数据处理
  const d = (k: keyof TrafficCounters) => Math.max(0, now[k] - prev[k]);
  const reset = (Object.keys(now) as (keyof TrafficCounters)[]).some((k) => now[k] < prev[k]);
  const lost = reset ? 0 : d('lost');
  const received = reset ? 0 : d('received');
  const emitted = reset ? 0 : d('jitterEmitted');
  const delay = d('jitterDelay');
  const freezes = reset ? 0 : d('freezes');
  Object.assign(prev, now);
  return {
    t,
    upRttMs,
    upLoss,
    cameraLimited,
    shareLimited,
    downLoss: lost + received > 0 ? lost / (lost + received) : null,
    downPackets: received,
    jitterBufferMs: emitted > 0 ? (delay / emitted) * 1000 : null,
    freezes,
  };
}
