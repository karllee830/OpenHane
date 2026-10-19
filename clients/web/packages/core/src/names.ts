// 显示名的清洗：服务端（以及经服务端转来的）名称一律不信任，显示前按与服务端相同的规则处理。
// 规则见 server/internal/identity 的 NormalizeDisplayName；这里不拒绝，而是去掉不合规的部分、过长时截断。

/** 名称最多显示多少个字符（服务端的上限） */
export const MAX_NAME_CHARS = 32;
/** 连续的组合字符（声调符号等）最多保留几个：再多就是把字往上下堆出界的「Zalgo」文字 */
const MAX_COMBINING_RUN = 3;

/**
 * 清洗一个显示名：转成 NFC；去掉格式字符（零宽字符、方向控制符等）；控制字符、换行和其他空白换成空格并合并；连续的组合字符最多保留 3 个；超过 max 个字符时截断并加省略号。不是字符串时返回空字符串。
 */
export function cleanDisplayName(raw: unknown, max = MAX_NAME_CHARS): string {
  if (typeof raw !== 'string') return '';
  // 先截一段再处理：服务端可能发来极长的字符串
  let s = raw.slice(0, max * 8).normalize('NFC');
  s = s.replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/gu, ' ').trim();
  s = s.replace(new RegExp(`([\\p{Mn}\\p{Me}]{${MAX_COMBINING_RUN}})[\\p{Mn}\\p{Me}]+`, 'gu'), '$1');
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : s;
}

/** 服务器信息里的名称清洗后再放进状态（界面各处都从状态里取） */
export function withCleanName<T extends { name: string }>(info: T): T;
export function withCleanName<T extends { name: string }>(info: T | undefined | null): T | null;
export function withCleanName<T extends { name: string }>(info: T | undefined | null): T | null {
  return info ? { ...info, name: cleanDisplayName(info.name) } : null;
}
