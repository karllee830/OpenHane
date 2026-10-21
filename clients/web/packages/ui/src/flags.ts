// 国旗 emoji。Windows 自带的表情字体没有国旗（只显示两个字母），缺的时候注册随应用打包的 Twemoji 国旗字体，
// 字体只覆盖国旗用到的码位（unicode-range），不影响其他文字。
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';
import flagFontUrl from 'country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url';

/** 显示国旗时指定的字体：系统能显示国旗时这个字体不存在，自动回退到系统字体 */
export const FLAG_FONT_FAMILY = "'Twemoji Country Flags', var(--font-sans)";

let installed = false;

/** 需要时注册国旗字体（只做一次；检测要用 canvas，在第一次显示国旗时再做） */
export function ensureFlagFont() {
  if (installed) return;
  installed = true;
  try {
    polyfillCountryFlagEmojis('Twemoji Country Flags', flagFontUrl);
  } catch {
    // 没有 canvas 的环境（测试）不需要
  }
}

/** 两位国家代码（如 CN）→ 国旗 emoji；格式不对时为空 */
export function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
