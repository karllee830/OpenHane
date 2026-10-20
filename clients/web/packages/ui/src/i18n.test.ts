import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dicts, pickLocale, translator } from './i18n';

describe('i18n', () => {
  it('picks locale and interpolates', () => {
    expect(pickLocale(['en-US'])).toBe('en');
    expect(pickLocale(['zh-TW', 'en'])).toBe('zh-CN');
    expect(pickLocale(['fr'])).toBe('zh-CN');
    expect(translator('en')('room.members', { n: 3 })).toBe('3 people');
    expect(translator('zh-CN')('room.members', { n: 3 })).toBe('3 人');
  });

  it('every translation uses the same placeholders as the Chinese source', () => {
    const vars = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const problems: string[] = [];
    for (const [key, zh] of Object.entries(dicts['zh-CN'])) {
      const en = dicts.en[key as keyof typeof dicts.en];
      if (!en?.trim()) problems.push(`${key}: missing English`);
      else if (vars(zh).join() !== vars(en).join()) problems.push(`${key}: {${vars(zh)}} vs {${vars(en)}}`);
    }
    expect(problems).toEqual([]);
  });

  it('names the safety code emoji as in the shared table', () => {
    const table: { zh: string; en: string }[] = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../testdata/e2ee/safety-emoji.json'), 'utf8'));
    table.forEach((e, i) => {
      const key = `e2ee.emoji.${i}` as keyof typeof dicts.en;
      expect([dicts['zh-CN'][key], dicts.en[key]]).toEqual([e.zh, e.en]);
    });
  });
});
