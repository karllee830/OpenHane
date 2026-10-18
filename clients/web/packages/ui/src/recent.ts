// 最近连接的服务器（连接页）：地址、服务器名称、上次连接时间、是否需要服务器密码。
import { hostPort, parseAddress } from '@hane/core';
import type { KeyValueStore } from '@hane/platform';

export interface RecentServer {
  /** 连接时填写的地址（去掉了邀请码） */
  address: string;
  /** 服务器名称；旧版本保存的记录可能没有 */
  name: string;
  /** 上次连接成功的时间（毫秒）；0 表示未知 */
  at: number;
  /** 服务器设置了密码：再次连接时直接显示密码框 */
  password?: boolean;
}

export const MAX_RECENT = 5;
const KEY = 'recentServers';
/** 旧版本只保存地址列表 */
const LEGACY_KEY = 'recent';

/** 同一台服务器的不同写法（meet.example.com 与 meet.example.com:9800）视为同一条 */
function sameServer(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const p = parseAddress(s);
      return `${p.secure ? 's' : 'p'}:${hostPort(p).toLowerCase()}`;
    } catch {
      return s.trim().toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/** 去掉地址中的邀请码（https://host/j/<码>）：邀请码可能已用完或过期，不应在下次连接时再带上 */
export function withoutInvite(address: string): string {
  try {
    const a = parseAddress(address);
    if (!a.invite) return address.trim();
    return `${a.secure ? '' : 'http://'}${hostPort(a)}`;
  } catch {
    return address.trim();
  }
}

export function loadRecent(storage: KeyValueStore): RecentServer[] {
  const list = storage.get<RecentServer[]>(KEY);
  if (Array.isArray(list)) return list.filter((r) => r && typeof r.address === 'string' && r.address).slice(0, MAX_RECENT);
  const legacy = storage.get<string[]>(LEGACY_KEY);
  if (!Array.isArray(legacy)) return [];
  return legacy
    .filter((a) => typeof a === 'string' && a)
    .slice(0, MAX_RECENT)
    .map((address) => ({ address, name: '', at: 0 }));
}

/** 连接成功后记下这台服务器（放到最前面） */
export function rememberServer(storage: KeyValueStore, entry: RecentServer): RecentServer[] {
  const address = withoutInvite(entry.address);
  const list = [{ ...entry, address }, ...loadRecent(storage).filter((r) => !sameServer(r.address, address))].slice(0, MAX_RECENT);
  storage.set(KEY, list);
  return list;
}

export function forgetServer(storage: KeyValueStore, address: string): RecentServer[] {
  const list = loadRecent(storage).filter((r) => r.address !== address);
  storage.set(KEY, list);
  return list;
}

/** 与地址对应的记录（不区分 meet.example.com 与 meet.example.com:9800 这类写法） */
export function findRecent(list: readonly RecentServer[], address: string): RecentServer | undefined {
  return address.trim() ? list.find((r) => sameServer(r.address, address)) : undefined;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** 「3 小时前」「昨天」这样的相对时间；不到一分钟时用 justNow（Intl 的说法是「现在」） */
export function relativeTime(at: number, locale: string, justNow?: string, now = Date.now()): string {
  const diff = (at - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, seconds] of UNITS) if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  return justNow ?? rtf.format(0, 'second');
}
