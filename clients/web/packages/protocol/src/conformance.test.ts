/// <reference types="node" />
// 协议一致性：proto/testdata/conformance/ 中由 Go 生成的样例，TypeScript 必须解码出与规范 JSON 相同的内容，
// 重新编码后再解码仍然相同；带未知字段的消息（模拟新版本服务端）必须照常解码。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, fromBinary, toBinary } from './index';
import { toJson } from '@bufbuild/protobuf';

const DIR = resolve(import.meta.dirname, '../../../../../proto/testdata/conformance');
const names: string[] = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));

describe('protocol conformance (shared samples)', () => {
  it('has samples', () => expect(names.length).toBeGreaterThan(20));

  it.each(names)('%s', (name) => {
    const bin = new Uint8Array(readFileSync(join(DIR, `${name}.bin`)));
    const want = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
    const msg = fromBinary(EnvelopeSchema, bin);
    expect(toJson(EnvelopeSchema, msg)).toEqual(want);
    const again = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, msg));
    expect(toJson(EnvelopeSchema, again)).toEqual(want);
  });
});
