// 主线程与 AudioWorklet 之间的消息。
import type { GateConfig } from './gate';

/** 降噪档位：AI 为 DeepFilterNet3，标准为 RNNoise */
export type NoiseSuppression = 'off' | 'standard' | 'ai';

export interface VoiceOptions extends GateConfig {
  ns: NoiseSuppression;
}

export type ToWorklet =
  | { type: 'options'; options: VoiceOptions }
  | { type: 'ptt'; pressed: boolean }
  // AI 降噪：WASM 和模型文件的内容（AudioWorklet 里同步编译、加载）
  | { type: 'dfn'; wasm: ArrayBuffer; model: ArrayBuffer }
  | { type: 'dfn-failed' };

/**
 * 降噪状态。fallback：AI 降噪加载失败，slow：设备处理不过来（连续 3 秒每帧超过 4 ms），
 * 这两种情况都自动改用标准降噪（RNNoise）。
 */
export type NsState = 'off' | 'loading' | 'active' | 'unavailable' | 'fallback' | 'slow';

export interface VoiceStatus {
  /** 门控使用的电平（dBFS）：AI 降噪时为降噪后的电平，否则为降噪前 */
  levelDb: number;
  /** 门是否打开（自己是否在发声） */
  speaking: boolean;
  /** 语音概率（RNNoise 的输出，或由 DeepFilterNet 的局部信噪比换算）；没有降噪时为 null */
  vad: number | null;
  thresholdDb: number;
  ns: NsState;
}

export type FromWorklet = { type: 'status'; status: VoiceStatus } | { type: 'need-rnnoise'; reason: string };

export const PROCESSOR_NAME = 'hane-voice';
/** RNNoise 加载完成后放在 AudioWorkletGlobalScope 上的全局名 */
export const RNNOISE_GLOBAL = '__haneRnnoise';
