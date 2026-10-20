import { describe, expect, it } from 'vitest';
import { cleanChatText, cleanDisplayName, MAX_CHAT_CHARS } from './names';

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

// 与服务端 identity.TestCleanChatText、Swift 版 DisplayNameTests 相同的用例
describe('cleanChatText', () => {
  it('matches the server rules', () => {
    const cases: [string, string][] = [
      ['  你好 \n', '你好'],
      ['Cafe\u0301', 'Caf\u00e9'],
      ['👨\u200d👩\u200d👧 1\ufe0f\u20e3', '👨\u200d👩\u200d👧 1\ufe0f\u20e3'],
      ['🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}', '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'],
      ['evil\u202egpj.exe', 'evilgpj.exe'],
      ['a\u200bb\u2066c\u2069', 'abc'],
      ['l1\r\nl2\rl3\u2028l4\tend', 'l1\nl2\nl3\nl4\tend'],
      ['\u0000a\u0007', 'a'],
      ['Z' + '\u0300'.repeat(50) + 'algo', 'Z\u0300\u0300\u0300algo'],
    ];
    for (const [input, want] of cases) expect(cleanChatText(input)).toBe(want);
  });

  it('limits length and ignores non-strings', () => {
    expect(Array.from(cleanChatText('字'.repeat(100_000)))).toHaveLength(MAX_CHAT_CHARS);
    for (const v of [undefined, null, 42, {}]) expect(cleanChatText(v)).toBe('');
  });
});
