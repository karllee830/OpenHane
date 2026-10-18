// 主线程 API：创建发言处理节点，转发设置，接收状态。
import rnnoiseWorkletUrl from './rnnoise.worklet.ts?worker&url';
import voiceWorkletUrl from './voice.worklet.ts?worker&url';
import { PROCESSOR_NAME, RNNOISE_GLOBAL, type FromWorklet, type NoiseSuppression, type ToWorklet, type VoiceOptions, type VoiceStatus } from './protocol';

export { Gate, rmsDb, type GateConfig, type VoiceMode } from './gate';
export { DeepFilter, lsnrToVad } from './deepfilter';
export type { NoiseSuppression, NsState, VoiceOptions, VoiceStatus } from './protocol';

// AI 降噪的 WASM 和模型由 clients/deepfilter/build.sh web 生成到 ../dfn/（不入库）。
// 没有生成时（本机没装 Rust）构建照常进行，只是不提供 AI 降噪。
const dfnFiles = import.meta.glob<string>('../dfn/*.{wasm,bin}', { query: '?url', import: 'default', eager: true });
const DFN_WASM_URL = dfnFiles['../dfn/hane-deepfilter.wasm'];
const DFN_MODEL_URL = dfnFiles['../dfn/deepfilternet3.bin'];

/** 这次构建是否带有 AI 降噪（DeepFilterNet3） */
export const aiNoiseAvailable = !!DFN_WASM_URL && !!DFN_MODEL_URL;

/**
 * 默认降噪档位：电脑上用 AI 降噪；手机、平板和 4 核以下的设备用更省电的标准降噪。
 */
export function defaultNoiseSuppression(): NoiseSuppression {
  if (!aiNoiseAvailable || typeof navigator === 'undefined') return 'standard';
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobi/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  return mobile || (navigator.hardwareConcurrency ?? 8) < 4 ? 'standard' : 'ai';
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
const rnnoiseLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}


export class VoiceProcessorNode {
  readonly node: AudioWorkletNode;
  private listeners = new Set<(s: VoiceStatus) => void>();
  private options: VoiceOptions;
  private dfnRequested = false;

  private constructor(ctx: AudioContext, options: VoiceOptions) {
    this.options = options;
    this.node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: options,
    });
    this.node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      if (e.data.type === 'status') for (const fn of this.listeners) fn(e.data.status);
      // AI 降噪不可用（加载失败 / 设备太慢），改用 RNNoise（AudioWorklet 里的日志不一定显示在页面控制台，在这里打印原因）
      else if (e.data.type === 'need-rnnoise') {
        console.warn(`AI noise suppression unavailable (${e.data.reason}); using RNNoise`);
        void this.loadNoiseModel(ctx);
      }
    };
  }

  /** 创建处理节点；AudioContext 必须是 48 kHz（RNNoise 和 DeepFilterNet 的采样率）。 */
  static async create(ctx: AudioContext, options: VoiceOptions): Promise<VoiceProcessorNode> {
    if (ctx.sampleRate !== 48000) throw new Error(`AudioContext must run at 48 kHz, got ${ctx.sampleRate}`);
    let p = loaded.get(ctx);
    if (!p) {
      p = ctx.audioWorklet.addModule(voiceWorkletUrl);
      loaded.set(ctx, p);
    }
    await p;
    const v = new VoiceProcessorNode(ctx, options);
    v.loadForOptions();
    return v;
  }

  private loadForOptions() {
    if (this.options.ns === 'standard') void this.loadNoiseModel(this.node.context);
    if (this.options.ns === 'ai') this.loadDeepFilter();
  }

  /** 懒加载 RNNoise 模型（同一个 AudioContext 只加载一次）。 */
  loadNoiseModel(ctx: BaseAudioContext): Promise<void> {
    let p = rnnoiseLoaded.get(ctx);
    if (!p) {
      p = ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
      rnnoiseLoaded.set(ctx, p);
    }
    return p;
  }

  /**
   * 下载 AI 降噪的 WASM（约 13 MB，gzip 后约 3 MB）和模型（约 8 MB），转交给 AudioWorklet 编译、加载（同一个节点只做一次）。
   * 不在主线程留副本：文件名带内容哈希、长期缓存，再次进入会议时从浏览器缓存读取。
   * 传字节而不是编译好的 WebAssembly.Module：后者在桌面版（app:// 协议）里传不进 AudioWorklet（反序列化失败）。
   */
  private loadDeepFilter() {
    if (this.dfnRequested) return;
    this.dfnRequested = true;
    if (!aiNoiseAvailable) {
      this.post({ type: 'dfn-failed' });
      return;
    }
    Promise.all([fetchBytes(DFN_WASM_URL!), fetchBytes(DFN_MODEL_URL!)]).then(
      ([wasm, model]) => this.post({ type: 'dfn', wasm, model }, [wasm, model]),
      (err) => {
        console.error('DeepFilterNet assets failed to load', err);
        this.post({ type: 'dfn-failed' });
      },
    );
  }

  setOptions(options: Partial<VoiceOptions>): void {
    this.options = { ...this.options, ...options };
    this.post({ type: 'options', options: this.options });
    this.loadForOptions();
  }

  get currentOptions(): VoiceOptions {
    return this.options;
  }

  setPushToTalk(pressed: boolean): void {
    this.post({ type: 'ptt', pressed });
  }

  onStatus(fn: (s: VoiceStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.listeners.clear();
    this.node.port.onmessage = null;
    this.node.disconnect();
  }

  private post(m: ToWorklet, transfer: Transferable[] = []) {
    this.node.port.postMessage(m, transfer);
  }
}

export { RNNOISE_GLOBAL };
