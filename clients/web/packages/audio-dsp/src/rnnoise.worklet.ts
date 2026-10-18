// 在 AudioWorkletGlobalScope 中加载 RNNoise，完成后挂到全局，供 voice.worklet.ts 中已在运行的处理器使用。
// 该包的 Emscripten 胶水代码只检查 window / WorkerGlobalScope 是否存在，worklet 里两者都没有，
// 所以先补一个空的 WorkerGlobalScope（它不依赖 fetch / atob：wasm 内嵌并用自带的 base64 解码）。
import './worklet-shim';
import { Rnnoise } from '@shiguredo/rnnoise-wasm';
import { RNNOISE_GLOBAL } from './protocol';

Rnnoise.load().then(
  (rn) => {
    (globalThis as Record<string, unknown>)[RNNOISE_GLOBAL] = rn;
  },
  (err) => {
    console.error('RNNoise failed to load', err);
    (globalThis as Record<string, unknown>)[RNNOISE_GLOBAL] = null;
  },
);
