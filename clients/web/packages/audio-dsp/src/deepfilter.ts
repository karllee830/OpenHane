// AI 降噪：DeepFilterNet3（clients/deepfilter 编译的 WASM）。
// 不依赖 DOM：在 AudioWorklet 里同步实例化，单元测试里直接在 Node 中运行。

/** 每帧采样数：48 kHz 下 10 ms */
export const DFN_FRAME = 480;

interface Exports {
  memory: WebAssembly.Memory;
  hane_alloc(len: number): number;
  hane_free(ptr: number, len: number): void;
  hane_df_create(model: number, len: number, attenLimDb: number): number;
  hane_df_sample_rate(st: number): number;
  hane_df_hop(st: number): number;
  hane_df_process(st: number, input: number, output: number): number;
  hane_df_destroy(st: number): void;
}

export class DeepFilter {
  private readonly ex: Exports;
  private readonly st: number;
  private readonly inPtr: number;
  private readonly outPtr: number;
  private input!: Float32Array;
  private output!: Float32Array;

  /** 解析并优化模型，耗时 0.1–0.5 秒（在 AudioWorklet 里会让这段时间的麦克风声音中断一下）。 */
  constructor(module: WebAssembly.Module, model: ArrayBuffer | Uint8Array) {
    this.ex = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    const bytes = model instanceof Uint8Array ? model : new Uint8Array(model);
    const p = this.ex.hane_alloc(bytes.length);
    new Uint8Array(this.ex.memory.buffer, p, bytes.length).set(bytes);
    this.st = this.ex.hane_df_create(p, bytes.length, 100);
    this.ex.hane_free(p, bytes.length);
    if (!this.st) throw new Error('DeepFilterNet: failed to load the model');
    if (this.ex.hane_df_sample_rate(this.st) !== 48000 || this.ex.hane_df_hop(this.st) !== DFN_FRAME) {
      this.ex.hane_df_destroy(this.st);
      throw new Error('DeepFilterNet: unexpected model format');
    }
    this.inPtr = this.ex.hane_alloc(DFN_FRAME * 4);
    this.outPtr = this.ex.hane_alloc(DFN_FRAME * 4);
    this.views();
  }

  // WASM 内存增长后原来的视图会失效（buffer 被换掉），需要重新创建
  private views() {
    this.input = new Float32Array(this.ex.memory.buffer, this.inPtr, DFN_FRAME);
    this.output = new Float32Array(this.ex.memory.buffer, this.outPtr, DFN_FRAME);
  }

  /** 原地处理一帧（480 点，[-1, 1]），返回局部信噪比估计（dB，约 -15～35；出错时为 NaN）。输出比输入晚约 30 ms。 */
  process(frame: Float32Array): number {
    if (this.input.buffer !== this.ex.memory.buffer) this.views();
    this.input.set(frame);
    const lsnr = this.ex.hane_df_process(this.st, this.inPtr, this.outPtr);
    if (this.output.buffer !== this.ex.memory.buffer) this.views();
    frame.set(this.output);
    return lsnr;
  }

  destroy(): void {
    this.ex.hane_df_destroy(this.st);
  }
}

/**
 * 把 DeepFilterNet 的局部信噪比换算成语音概率（0 dB 对应 0.5），供发言门控使用。
 * 门控按 0.5 判断，相当于局部信噪比 > 0 dB 才算人声。
 */
export function lsnrToVad(lsnr: number): number | null {
  return Number.isFinite(lsnr) ? 1 / (1 + Math.exp(-lsnr / 3)) : null;
}
