import { describe, expect, it } from 'vitest';
import { flagEmoji } from './flags';

describe('flagEmoji', () => {
  it('turns a country code into regional indicator symbols', () => {
    expect(flagEmoji('CN')).toBe('🇨🇳');
    expect(flagEmoji('US')).toBe('🇺🇸');
  });
  it('ignores anything that is not two capital letters', () => {
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('cn')).toBe('');
    expect(flagEmoji('0')).toBe('');
  });
});
