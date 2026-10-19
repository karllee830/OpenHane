import { describe, expect, it } from 'vitest';
import { cleanDisplayName } from './names';

describe('cleanDisplayName', () => {
  it('keeps normal names', () => {
    expect(cleanDisplayName('  研发组 ')).toBe('研发组');
    expect(cleanDisplayName('Việt Nam')).toBe('Việt Nam');
    expect(cleanDisplayName('Cafe\u0301')).toBe('Café'); // NFC
    expect(cleanDisplayName('👨\u200d👩\u200d👧 家')).toBe('👨👩👧 家'); // 零宽连接符也是格式字符，去掉
  });

  it('removes invisible and control characters and line breaks', () => {
    expect(cleanDisplayName('a\u200bb')).toBe('ab');
    expect(cleanDisplayName('evil\u202egpj.exe')).toBe('evilgpj.exe');
    expect(cleanDisplayName('line1\nline2\u2028line3\tend')).toBe('line1 line2 line3 end');
    expect(cleanDisplayName('\u0000\u0007')).toBe('');
  });

  it('limits stacked combining marks and length', () => {
    expect(Array.from(cleanDisplayName('Z' + '\u0300'.repeat(50) + 'algo')).length).toBe(1 + 3 + 4);
    const long = cleanDisplayName('字'.repeat(10_000));
    expect(Array.from(long)).toHaveLength(33);
    expect(long.endsWith('…')).toBe(true);
  });

  it('ignores non-strings', () => {
    for (const v of [undefined, null, 42, {}, ['a']]) expect(cleanDisplayName(v)).toBe('');
  });
});
