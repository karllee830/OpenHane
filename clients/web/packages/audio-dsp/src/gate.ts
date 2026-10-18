// 发言门控：纯逻辑，按 10 ms 帧更新，便于单元测试。
// 判定依据：RNNoise 的语音概率（有降噪时）+ 能量门限（自适应噪声底）。

export type VoiceMode = 'voice' | 'ptt' | 'open';

export interface GateConfig {
  mode: VoiceMode;
  /** 'auto' 或手动门限（dBFS，如 -50） */
  threshold: 'auto' | number;
}

export const FRAME_MS = 10;
const VOICE_HOLD_MS = 300; // 语音激活：句尾保持，避免截断
const PTT_HOLD_MS = 200; // 按键说话：松开后再保持
const VAD_SPEECH = 0.5;

export class Gate {
  noiseFloorDb = -60;
  private holdMs = 0;
  private open = false;
  pttPressed = false;

  constructor(public config: GateConfig) {}

  /** 当前生效的能量门限（dBFS） */
  thresholdDb(): number {
    const t = this.config.threshold;
    return t === 'auto' ? Math.max(this.noiseFloorDb + 10, -55) : t;
  }

  /**
   * 处理一帧：levelDb 为该帧（降噪前）的 RMS 电平，vad 为 RNNoise 语音概率（没有降噪时传 null）。
   * 返回门是否打开。
   */
  update(levelDb: number, vad: number | null): boolean {
    const threshold = this.thresholdDb();
    const speech = vad === null ? levelDb > threshold : vad >= VAD_SPEECH && levelDb > threshold - 10;
    // 噪声底：下降快、上升慢；被判为语音的帧上升更慢（约 5 秒吸收持续的稳态噪声，
    // 否则在一开始就很吵的环境里噪声被当成人声，门会一直开着）。语音有停顿，停顿处会把噪声底拉回来。
    const a = levelDb < this.noiseFloorDb ? 0.2 : speech ? 0.005 : 0.02;
    this.noiseFloorDb = Math.min(-20, Math.max(-90, this.noiseFloorDb + a * (levelDb - this.noiseFloorDb)));
    switch (this.config.mode) {
      case 'open':
        this.open = true;
        break;
      case 'ptt':
        if (this.pttPressed) {
          this.open = true;
          this.holdMs = PTT_HOLD_MS;
        } else if (this.open) {
          this.holdMs -= FRAME_MS;
          this.open = this.holdMs > 0;
        }
        break;
      case 'voice':
        if (speech) {
          this.open = true;
          this.holdMs = VOICE_HOLD_MS;
        } else if (this.open) {
          this.holdMs -= FRAME_MS;
          this.open = this.holdMs > 0;
        }
        break;
    }
    return this.open;
  }
}

export function rmsDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return 10 * Math.log10(sum / frame.length + 1e-12);
}
