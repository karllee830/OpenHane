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

/** 聊天正文最多显示多少个字符（服务端设置的上限） */
export const MAX_CHAT_CHARS = 10_000;

/**
 * 清洗聊天正文（与服务端 identity.CleanChatText 的规则相同）：转成 NFC；换行统一成 \n，制表符保留，其他控制字符去掉；
 * 去掉格式字符（方向控制符、零宽空格等），但保留零宽连接符 / 非连接符和标签字符（emoji 序列和一些文字要用）；
 * 连续的组合字符最多保留 3 个；去掉首尾空白，过长时截断。不是字符串时返回空字符串。
 */
export function cleanChatText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, MAX_CHAT_CHARS * 8).normalize('NFC');
  s = s.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/(?![\t\n\u200c\u200d\u{e0020}-\u{e007f}])[\p{Cc}\p{Cf}]/gu, '');
  s = s.replace(new RegExp(`([\\p{Mn}\\p{Me}]{${MAX_COMBINING_RUN}})[\\p{Mn}\\p{Me}]+`, 'gu'), '$1').trim();
  const chars = Array.from(s);
  return chars.length > MAX_CHAT_CHARS ? chars.slice(0, MAX_CHAT_CHARS).join('') : s;
}

/** 聊天消息的正文和发送者名称清洗后再放进状态 */
export function withCleanChat<T extends { text: string; senderName: string }>(m: T): T {
  return { ...m, text: cleanChatText(m.text), senderName: cleanDisplayName(m.senderName) };
}

/** 服务器信息里的名称清洗后再放进状态（界面各处都从状态里取） */
export function withCleanName<T extends { name: string }>(info: T): T;
export function withCleanName<T extends { name: string }>(info: T | undefined | null): T | null;
export function withCleanName<T extends { name: string }>(info: T | undefined | null): T | null {
  return info ? { ...info, name: cleanDisplayName(info.name) } : null;
}
