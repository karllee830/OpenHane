/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScreenShareEngine, type CustomShare, type Signals } from './engine';

interface Vector {
  name: string;
  intent: 'smart' | 'text' | 'motion' | 'custom';
  custom?: CustomShare;
  codec: 'av1' | 'vp9' | 'h264' | 'vp8';
  caps: { maxHeight: number; maxFps: number; maxKbps: number };
  source: { width: number; height: number };
  samples: Signals[];
  expect: ({ t: number } & Record<string, unknown>)[];
}

// 与 Swift 版共用的测试向量
const { vectors } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../testdata/share-engine/vectors.json'), 'utf8')) as { vectors: Vector[] };

describe('ScreenShareEngine (shared vectors)', () => {
  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const engine = new ScreenShareEngine({ intent: v.intent, caps: v.caps, source: v.source, codec: v.codec, custom: v.custom });
    const outputs = new Map<number, Record<string, unknown>>();
    for (const s of v.samples) outputs.set(s.t, { ...engine.update(s) });
    for (const e of v.expect) {
      const got = outputs.get(e.t);
      expect(got, `no output at t=${e.t}`).toBeDefined();
      for (const [k, want] of Object.entries(e)) if (k !== 't') expect(got![k], `t=${e.t} ${k}`).toBe(want);
    }
  });
});
