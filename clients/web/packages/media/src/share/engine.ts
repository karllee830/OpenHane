// 屏幕共享自适应引擎：与平台无关的纯逻辑。输入每 500 ms 一次的信号采样，输出发送参数。
// 与 Swift 版实现共用测试向量（仓库根目录 testdata/share-engine/vectors.json）。

export type ShareMode = 'text' | 'motion';
export type EngineIntent = 'smart' | 'text' | 'motion' | 'custom';
export type EngineCodec = 'av1' | 'vp9' | 'h265' | 'h264' | 'vp8';
export type QualityLimitation = 'none' | 'cpu' | 'bandwidth' | 'other';
export type Thermal = 'nominal' | 'fair' | 'serious' | 'critical';

/** 自定义档：用户指定的分辨率（高度，null 为原始分辨率）、帧率和码率（kbps，null 为自动） */
export interface CustomShare {
  height: number | null;
  fps: number;
  kbps: number | null;
  /** 用户指定的编码器（只能选本机能硬件编码的）；省略或 null 为自动。引擎本身不使用 */
  codec?: ShareCodecPref | null;
}

/** 自定义里可以指定的编码器 */
export type ShareCodecPref = 'av1' | 'h265' | 'h264';

export interface EngineCaps {
  maxHeight: number;
  maxFps: number;
  maxKbps: number;
}

export interface Signals {
  t: number; // 采样时间（ms）
  changedAreaRatio: number; // 最近 0.5 秒有变化的帧平均变化面积（0–1）
  changeFps: number; // 每秒有变化的帧数
  uplinkKbps: number; // 上行可用带宽估计
  qualityLimitation: QualityLimitation;
  thermal?: Thermal;
  /** 媒体连接的往返时间（毫秒）。有这个信号时按 BBR 的思路调整档位（见 paceByDelivery） */
  rttMs?: number;
  /** 这路共享实际发送的码率（kbps） */
  sentKbps?: number;
}

export interface ShareParams {
  mode: ShareMode;
  level: number;
  width: number;
  height: number;
  fps: number;
  maxKbps: number;
  degradationPreference: RTCDegradationPreference;
  contentHint: 'text' | 'motion';
}

export const TUNING = {
  toMotion: { minChangedArea: 0.15, minChangeFps: 20, holdMs: 2000 },
  // 返回清晰模式看「活跃占比」，只统计进入流畅模式之后的采样，并且至少停留 minDwellMs
  toText: { windowMs: 8000, maxActiveRatio: 0.4, minDwellMs: 4000 },
  jitterToleranceMs: 250,
  degrade: { cpuHoldMs: 3000, bandwidthHoldMs: 5000, bandwidthRatio: 0.6 },
  recover: { stableMs: 10000, headroom: 1.3 },
  uplinkUsable: 0.85,
  // 借鉴 BBR：最近 windowMs 的最低往返时间当作「不排队时的往返时间」，往返时间持续 queueHoldMs
  // 高于它的 queueFactor 倍 + queueSlackMs 就是在排队，降到最近送达速率 × drainGain 放得下的档位；
  // 既不排队、也不受带宽限制持续 probeMs，就试探着升一档（升上去引起排队或受限会马上退回来）
  // WebRTC 报告受带宽限制、且带宽估计不到当前档位的 bandwidthRatio、持续 limitedHoldMs：降到估计值放得下的档位
  pace: { windowMs: 10000, queueFactor: 1.5, queueSlackMs: 30, queueHoldMs: 1000, drainGain: 0.9, probeMs: 3000, limitedHoldMs: 2000 },
};

interface Profile {
  fpsLadder: number[];
  heightLadder: number[];
  degradationPreference: RTCDegradationPreference;
  contentHint: 'text' | 'motion';
  order: ('fps' | 'height')[];
}

const PROFILES: Record<ShareMode, Profile> = {
  text: { fpsLadder: [15, 10, 5], heightLadder: [2160, 1440, 1080], degradationPreference: 'maintain-resolution', contentHint: 'text', order: ['fps', 'height'] },
  motion: { fpsLadder: [60, 30], heightLadder: [1080, 720], degradationPreference: 'maintain-framerate', contentHint: 'motion', order: ['height', 'fps'] },
};

// 码率参考（kbps，AV1 基准；用画质评估工具校准）
const TEXT_KBPS: Record<number, number> = { 1080: 800, 1440: 1200, 2160: 2500 };
const MOTION_KBPS: Record<number, { 30: number; 60: number }> = {
  720: { 30: 2000, 60: 3000 },
  1080: { 30: 3500, 60: 7000 },
  1440: { 30: 5500, 60: 8000 },
};
// 其他编码器相对 AV1 的码率系数，按模式分开：滚动文字时 H.264 需要的码率远高于 AV1，动态画面时差距小得多
// （H.265 同码率下画质明显高于 H.264，文字仍不如 AV1）
export const CODEC_FACTOR: Record<ShareMode, Record<EngineCodec, number>> = {
  text: { av1: 1.0, vp9: 2.0, h265: 1.2, h264: 1.5, vp8: 1.6 },
  motion: { av1: 1.0, vp9: 1.3, h265: 1.0, h264: 1.2, vp8: 1.6 },
};

function nearestKey(obj: Record<number, unknown>, h: number): number {
  const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
  return keys.find((k) => k >= h) ?? keys[keys.length - 1]!;
}

/** 自定义档按帧率决定画面类型：24 fps 及以上按动态画面（保帧率），以下按文字（保分辨率） */
export function customMode(c: CustomShare): ShareMode {
  return c.fps >= 24 ? 'motion' : 'text';
}

export class ScreenShareEngine {
  intent: EngineIntent;
  mode: ShareMode;
  private modeSince = -Infinity;
  private level = 0;
  private history: Signals[] = [];
  private lastProblemAt = -Infinity;
  private degradeObserveFrom = -Infinity;
  private levelChangedAt = -Infinity;
  params: ShareParams | null = null;

  constructor(o: { intent: EngineIntent; caps: EngineCaps; source: { width: number; height: number }; codec: EngineCodec; custom?: CustomShare }) {
    this.intent = o.intent;
    this.caps = o.caps;
    this.source = o.source;
    this.codec = o.codec;
    this.custom = o.custom ?? null;
    // 智能模式从「清晰」起步
    this.mode = o.intent === 'motion' ? 'motion' : o.intent === 'custom' && this.custom ? customMode(this.custom) : 'text';
  }

  caps: EngineCaps;
  source: { width: number; height: number };
  codec: EngineCodec;
  custom: CustomShare | null;

  /** 切换意图；切到自定义时同时给出参数 */
  setIntent(intent: EngineIntent, now: number, custom?: CustomShare): void {
    this.intent = intent;
    if (custom) this.custom = custom;
    if (intent === 'custom' && this.custom) this.switchMode(customMode(this.custom), now);
    else if (intent !== 'smart') this.switchMode(intent === 'motion' ? 'motion' : 'text', now);
  }

  private switchMode(mode: ShareMode, now: number) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeSince = now;
    this.level = 0;
    this.lastProblemAt = -Infinity;
    this.degradeObserveFrom = now;
  }

  private sustained(pred: (s: Signals) => boolean, holdMs: number, now: number, from = -Infinity): boolean {
    // 窗口多看一个抖动容差：采样间隔略大于 500 ms 时，最早的一个样本不会刚好掉出窗口（否则永远凑不满 holdMs）
    const w = this.history.filter((s) => now - s.t <= holdMs + TUNING.jitterToleranceMs && s.t >= from);
    if (!w.length || now - w[0]!.t < holdMs - TUNING.jitterToleranceMs) return false;
    return w.every(pred);
  }

  private ratio(pred: (s: Signals) => boolean, windowMs: number, now: number, from: number, minCoverMs: number): number | null {
    const w = this.history.filter((s) => now - s.t <= windowMs && s.t >= from);
    if (!w.length || now - w[0]!.t < minCoverMs - TUNING.jitterToleranceMs) return null;
    return w.filter(pred).length / w.length;
  }

  static isActive(x: Signals): boolean {
    return x.changedAreaRatio > TUNING.toMotion.minChangedArea && x.changeFps >= TUNING.toMotion.minChangeFps;
  }

  update(s: Signals): ShareParams {
    const now = s.t;
    this.history.push(s);
    this.history = this.history.filter((x) => now - x.t <= 12000);
    if (this.intent === 'custom' && this.custom) return (this.params = this.customParams(this.custom));

    if (this.intent === 'smart') {
      if (this.mode === 'text' && this.sustained(ScreenShareEngine.isActive, TUNING.toMotion.holdMs, now)) {
        this.switchMode('motion', now);
      } else if (this.mode === 'motion') {
        const active = this.ratio(ScreenShareEngine.isActive, TUNING.toText.windowMs, now, this.modeSince, TUNING.toText.minDwellMs);
        if (active !== null && active < TUNING.toText.maxActiveRatio) this.switchMode('text', now);
      }
    }

    const target = this.compute(this.level);
    const usable = s.uplinkKbps * TUNING.uplinkUsable;
    const from = this.degradeObserveFrom;
    const cpu = this.sustained((x) => x.qualityLimitation === 'cpu', TUNING.degrade.cpuHoldMs, now, from);
    const hot = this.sustained((x) => x.thermal === 'serious' || x.thermal === 'critical', TUNING.degrade.cpuHoldMs, now, from);
    const bw = this.sustained(
      (x) => x.uplinkKbps * TUNING.uplinkUsable < target.targetKbps * TUNING.degrade.bandwidthRatio,
      TUNING.degrade.bandwidthHoldMs,
      now,
      from,
    );
    const paced = s.rttMs !== undefined;
    if (paced) {
      this.paceByDelivery(s, now, cpu || hot);
    } else if ((cpu || hot || bw) && this.level < this.maxLevel()) {
      this.level++;
      this.lastProblemAt = now;
      this.degradeObserveFrom = now;
    } else if (cpu || hot || bw) {
      this.lastProblemAt = now;
    } else if (this.level > 0 && now - this.lastProblemAt >= TUNING.recover.stableMs) {
      const up = this.compute(this.level - 1);
      if (usable >= up.targetKbps * TUNING.recover.headroom) {
        this.level--;
        this.lastProblemAt = now;
      }
    }

    const p = this.compute(this.level);
    const pr = PROFILES[this.mode];
    this.params = {
      mode: this.mode,
      level: this.level,
      width: p.width,
      height: p.height,
      fps: p.fps,
      // 按送达速率调整档位时不按带宽估计压上限：实际发多少交给 WebRTC 的拥塞控制，压在估计值以下等于给爬升踩刹车
      maxKbps: Math.round(Math.min(p.targetKbps, this.caps.maxKbps, paced ? Infinity : Math.max(usable, 150))),
      // 按送达速率调整档位时分辨率由引擎决定：WebRTC 只降帧率，不自己降分辨率（它降下去以后升回来极慢）
      degradationPreference: paced ? 'maintain-resolution' : pr.degradationPreference,
      contentHint: pr.contentHint,
    };
    return this.params;
  }

  /**
   * 借鉴 BBR 调整档位（有往返时间信号时）。WebRTC 的拥塞控制主要看延迟变化，在 TCP 上把重传和排队的抖动当成拥塞；
   * 「保帧率」时它把分辨率降得很快、升回去极慢。
   * 所以这时分辨率由引擎决定（降级偏好设为保分辨率），引擎盯住往返时间和送达速率：
   * - 往返时间持续升高 = 在排队：降到最近送达速率放得下的档位（可以一次降多级）；
   * - WebRTC 报告受带宽限制、带宽估计不到当前档位的 60%：降到估计值放得下的档位；
   * - 既不排队、也不受限持续 3 秒：试探着升一档，升上去引起排队或受限会马上退回来（BBR 的探测）；
   * - CPU、发热时每次降一级。
   */
  private paceByDelivery(s: Signals, now: number, overloaded: boolean) {
    const P = TUNING.pace;
    const window = this.history.filter((x) => now - x.t <= P.windowMs && x.rttMs !== undefined);
    const rtProp = Math.min(...window.map((x) => x.rttMs!));
    const inflated = (x: Signals) => x.rttMs !== undefined && x.rttMs > rtProp * P.queueFactor + P.queueSlackMs;
    const setLevel = (l: number) => {
      this.level = l;
      this.levelChangedAt = now;
      this.lastProblemAt = now;
      this.degradeObserveFrom = now;
    };
    const max = this.maxLevel();
    // 降到 budget 放得下的档位（码率不低于档位参考码率的 ratio 倍），至少降一级
    const dropTo = (budget: number, ratio: number) => {
      let l = this.level + 1;
      while (l < max && this.compute(l).targetKbps * ratio > budget) l++;
      setLevel(Math.min(l, max));
    };
    const target = this.compute(this.level).targetKbps;
    const limited = (x: Signals) => x.qualityLimitation === 'bandwidth' && x.uplinkKbps < target * TUNING.degrade.bandwidthRatio;
    if (this.sustained(inflated, P.queueHoldMs, now, this.degradeObserveFrom)) {
      if (this.level >= max) return;
      const recent = this.history.filter((x) => now - x.t <= P.queueHoldMs + TUNING.jitterToleranceMs);
      dropTo(Math.max(...recent.map((x) => x.sentKbps ?? x.uplinkKbps)) * P.drainGain, 1);
    } else if (this.sustained(limited, P.limitedHoldMs, now, this.degradeObserveFrom)) {
      if (this.level < max) dropTo(s.uplinkKbps, TUNING.degrade.bandwidthRatio);
    } else if (overloaded) {
      if (this.level < max) setLevel(this.level + 1);
    } else if (
      this.level > 0 &&
      now - this.levelChangedAt >= P.probeMs &&
      this.sustained((x) => !inflated(x) && x.qualityLimitation !== 'bandwidth', P.probeMs, now)
    ) {
      setLevel(this.level - 1);
    }
  }


  /**
   * 自定义档：用用户指定的参数，只截到管理员上限，不随内容切换、不自动降级、不按上行带宽压码率
   * （带宽不够时由 WebRTC 的拥塞控制兜底）。分辨率不超过原始分辨率（不放大）。
   */
  private customParams(c: CustomShare): ShareParams {
    this.mode = customMode(c);
    this.level = 0;
    const height = Math.round(Math.min(c.height ?? this.source.height, this.source.height, this.caps.maxHeight) / 2) * 2;
    const width = Math.round((this.source.width * height) / this.source.height / 2) * 2;
    const fps = Math.max(1, Math.min(Math.round(c.fps), this.caps.maxFps));
    // 码率自动：清晰档按 15 fps 的参考码率随帧率放大，流畅档按 30 / 60 fps 的参考码率
    const base = this.mode === 'text' ? TEXT_KBPS[nearestKey(TEXT_KBPS, height)]! * Math.max(1, fps / 15) : MOTION_KBPS[nearestKey(MOTION_KBPS, height)]![fps >= 45 ? 60 : 30];
    const auto = base * (CODEC_FACTOR[this.mode][this.codec] ?? 1.5);
    const pr = PROFILES[this.mode];
    return {
      mode: this.mode,
      level: 0,
      width,
      height,
      fps,
      maxKbps: Math.round(Math.max(100, Math.min(c.kbps ?? auto, this.caps.maxKbps))),
      degradationPreference: pr.degradationPreference,
      contentHint: pr.contentHint,
    };
  }

  private ladders(): { heights: number[]; fpsList: number[] } {
    const pr = PROFILES[this.mode];
    const capH = Math.min(this.caps.maxHeight, this.source.height);
    const heights = pr.heightLadder.filter((h) => h <= capH);
    if (!heights.length) heights.push(capH);
    const fpsList = pr.fpsLadder.filter((f) => f <= this.caps.maxFps);
    if (!fpsList.length) fpsList.push(this.caps.maxFps);
    return { heights, fpsList };
  }

  private maxLevel(): number {
    const { heights, fpsList } = this.ladders();
    return heights.length - 1 + fpsList.length - 1;
  }

  private compute(level: number): { width: number; height: number; fps: number; targetKbps: number } {
    const pr = PROFILES[this.mode];
    const { heights, fpsList } = this.ladders();
    let hi = 0;
    let fi = 0;
    let remaining = level;
    for (const dim of pr.order) {
      if (dim === 'fps') {
        const d = Math.min(remaining, fpsList.length - 1);
        fi = d;
        remaining -= d;
      } else {
        const d = Math.min(remaining, heights.length - 1);
        hi = d;
        remaining -= d;
      }
    }
    const height = heights[hi]!;
    const width = Math.round((this.source.width * height) / this.source.height / 2) * 2;
    const fps = fpsList[fi]!;
    const base = this.mode === 'text' ? TEXT_KBPS[nearestKey(TEXT_KBPS, height)]! : MOTION_KBPS[nearestKey(MOTION_KBPS, height)]![fps >= 45 ? 60 : 30];
    return { width, height, fps, targetKbps: base * (CODEC_FACTOR[this.mode][this.codec] ?? 1.5) };
  }
}
