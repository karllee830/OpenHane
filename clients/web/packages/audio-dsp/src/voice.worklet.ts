// 发言处理 AudioWorklet：10 ms 帧适配 → 降噪（AI / 标准 / 关闭）→ 发言门控 → 输出。
// AI 降噪（DeepFilterNet3）的 WASM 和模型由主线程下载后把字节转交过来，在这里编译、加载；标准降噪的 RNNoise 由 rnnoise.worklet.ts 单独懒加载。
// 加载完成前只做能量门控，声音照常传输。AI 降噪加载失败或设备处理不过来时，自动改用 RNNoise。
import { DeepFilter, lsnrToVad } from './deepfilter';
import { FRAME_MS, Gate, rmsDb } from './gate';
import { PROCESSOR_NAME, RNNOISE_GLOBAL, type FromWorklet, type NsState, type ToWorklet, type VoiceOptions } from './protocol';

interface Denoiser {
  processFrame(frame: Float32Array): number;
  destroy(): void;
}
interface RnnoiseLike {
  frameSize: number;
  createDenoiseState(): Denoiser;
}

const FRAME = (48000 * FRAME_MS) / 1000; // 480
const STATUS_EVERY = 5; // 每 5 帧（50 ms）上报一次状态
const FADE = 240; // 门开关时 5 ms 淡入淡出，避免爆音
// AI 降噪的耗时监测：每秒（100 帧）算一次平均每帧耗时，连续 3 秒超过 4 ms（实时预算的 40%）就改用 RNNoise
const COST_WINDOW = 100;
const SLOW_MS = 4;
const SLOW_WINDOWS = 3;

class VoiceProcessor extends AudioWorkletProcessor {
  private options: VoiceOptions;
  private gate: Gate;
  private denoiser: Denoiser | null = null;
  private dfn: DeepFilter | null = null;
  /** AI 降噪不可用：'failed' 加载失败，'slow' 设备处理不过来 */
  private dfnDown: 'failed' | 'slow' | null = null;
  private dfnCostMs = 0;
  private dfnCostFrames = 0;
  private slowWindows = 0;
  private inBuf = new Float32Array(FRAME);
  private inLen = 0;
  // 输出 FIFO：预填一帧静音，保证每个 128 点块都有数据可读（带来约 10 ms 延迟）
  private outBuf = new Float32Array(FRAME * 4);
  private outRead = 0;
  private outLen = FRAME;
  private gain = 0;
  private frames = 0;

  constructor(opts?: { processorOptions?: unknown }) {
    super();
    this.options = opts?.processorOptions as VoiceOptions;
    this.gate = new Gate(this.options);
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const m = e.data;
      if (m.type === 'options') {
        this.options = m.options;
        this.gate.config = m.options;
        if (m.options.ns === 'off' && this.denoiser) {
          this.denoiser.destroy();
          this.denoiser = null;
        }
      } else if (m.type === 'ptt') {
        this.gate.pttPressed = m.pressed;
      } else if (m.type === 'dfn') {
        if (this.dfn) return;
        try {
          this.dfn = new DeepFilter(new WebAssembly.Module(m.wasm), m.model);
        } catch (err) {
          this.fallBack('failed', String(err));
        }
      } else if (m.type === 'dfn-failed') {
        this.fallBack('failed', 'assets unavailable');
      }
    };
    this.port.onmessageerror = () => this.fallBack('failed', 'message could not be deserialized');
  }

  private fallBack(reason: 'failed' | 'slow', detail: string) {
    this.dfnDown = reason;
    this.dfn?.destroy();
    this.dfn = null;
    this.post({ type: 'need-rnnoise', reason: `${reason}: ${detail}` });
  }

  private post(m: FromWorklet) {
    this.port.postMessage(m);
  }

  private nsState(): NsState {
    const ns = this.options.ns;
    if (ns === 'off') return 'off';
    if (ns === 'ai') {
      if (this.dfnDown === 'slow') return 'slow';
      if (this.dfnDown === 'failed') return 'fallback';
      return this.dfn ? 'active' : 'loading';
    }
    if (this.denoiser) return 'active';
    return (globalThis as Record<string, unknown>)[RNNOISE_GLOBAL] === null ? 'unavailable' : 'loading';
  }

  /** AI 降噪的耗时监测（AudioWorklet 里没有 performance.now()，用 Date.now() 按秒平均） */
  private trackCost(ms: number) {
    this.dfnCostMs += ms;
    if (++this.dfnCostFrames < COST_WINDOW) return;
    const avg = this.dfnCostMs / this.dfnCostFrames;
    this.dfnCostMs = this.dfnCostFrames = 0;
    this.slowWindows = avg > SLOW_MS ? this.slowWindows + 1 : 0;
    if (this.slowWindows >= SLOW_WINDOWS) {
      this.fallBack('slow', `${avg.toFixed(1)} ms per 10 ms frame`);
    }
  }

  private processFrame(frame: Float32Array): void {
    const ns = this.options.ns;
    const useDfn = ns === 'ai' && this.dfn !== null;
    // 标准档，以及 AI 降噪不可用时的后备
    const useRnnoise = ns === 'standard' || (ns === 'ai' && this.dfnDown !== null);
    if (useRnnoise && !this.denoiser) {
      const rn = (globalThis as Record<string, unknown>)[RNNOISE_GLOBAL] as RnnoiseLike | null | undefined;
      if (rn) this.denoiser = rn.createDenoiseState();
    }
    let level = rmsDb(frame);
    let vad: number | null = null;
    if (useDfn) {
      const t0 = Date.now();
      const lsnr = this.dfn!.process(frame);
      this.trackCost(Date.now() - t0);
      // 噪声已经去掉，门控按降噪后的电平判断；人声与否看局部信噪比
      level = rmsDb(frame);
      vad = lsnrToVad(lsnr);
    } else if (useRnnoise && this.denoiser) {
      // RNNoise 期望 16 位 PCM 的数值范围
      for (let i = 0; i < FRAME; i++) frame[i]! *= 32768;
      vad = this.denoiser.processFrame(frame);
      for (let i = 0; i < FRAME; i++) frame[i]! /= 32768;
    }
    const open = this.gate.update(level, vad);
    const target = open ? 1 : 0;
    for (let i = 0; i < FRAME; i++) {
      if (this.gain !== target) this.gain = Math.min(1, Math.max(0, this.gain + (target ? 1 : -1) / FADE));
      frame[i]! *= this.gain;
    }
    // 写入输出 FIFO
    const cap = this.outBuf.length;
    for (let i = 0; i < FRAME; i++) this.outBuf[(this.outRead + this.outLen + i) % cap] = frame[i]!;
    this.outLen = Math.min(cap, this.outLen + FRAME);

    if (++this.frames % STATUS_EVERY === 0) {
      this.post({ type: 'status', status: { levelDb: level, speaking: open, vad, thresholdDb: this.gate.thresholdDb(), ns: this.nsState() } });
    }
  }

  override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    const n = output.length;
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.inBuf[this.inLen++] = input[i]!;
        if (this.inLen === FRAME) {
          this.processFrame(this.inBuf);
          this.inLen = 0;
        }
      }
    }
    const cap = this.outBuf.length;
    for (let i = 0; i < n; i++) {
      if (this.outLen > 0) {
        output[i] = this.outBuf[this.outRead]!;
        this.outRead = (this.outRead + 1) % cap;
        this.outLen--;
      } else {
        output[i] = 0; // 欠载
      }
    }
    // 多声道输出时复制到其他声道
    for (let c = 1; c < (outputs[0]?.length ?? 0); c++) outputs[0]![c]!.set(output);
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, VoiceProcessor);
