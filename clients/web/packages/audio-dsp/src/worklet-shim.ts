// 必须在导入 RNNoise 之前执行（ES 模块按导入顺序求值）。
const g = globalThis as Record<string, unknown>;
if (typeof g.WorkerGlobalScope === 'undefined') g.WorkerGlobalScope = class {};
export {};
