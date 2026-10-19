// 服务器列表（主页）：最近连接过的服务器和收藏的服务器。记录地址、服务器名称、上次连接时间、是否需要服务器密码，
// 以及用户自己加的备注和在这台服务器上用的昵称。
import { cleanDisplayName, hostPort, parseAddress } from '@hane/core';
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
  /** 收藏：一直留在列表里，不受最近连接条数的限制 */
  favorite?: boolean;
  /** 用户加的备注，列表里代替服务器名称显示 */
  note?: string;
  /** 在这台服务器上用的昵称；没有时用默认昵称 */
  nickname?: string;
  /** 上次看到的服务器图标地址：打开列表时先显示它，测完延迟再更新 */
  logo?: string;
}

/** 没有收藏的服务器最多保留几条 */
export const MAX_RECENT = 5;
const KEY = 'recentServers';

/** 服务器的默认名称（与产品同名）：没有意义，列表和标题里改为显示备注或地址 */
const DEFAULT_SERVER_NAME = 'OpenHane';

/** 服务端给的服务器名称：清洗后（见 cleanDisplayName）；是默认名称时当作没有名称 */
export function cleanServerName(raw: unknown): string {
  const name = cleanDisplayName(raw);
  return name === DEFAULT_SERVER_NAME ? '' : name;
}

/** 列表和会议里显示的名称：有备注时显示备注，否则显示服务器名称，都没有时显示地址 */
export function serverTitle(r: Pick<RecentServer, 'note' | 'name' | 'address'>): string {
  return r.note?.trim() || cleanServerName(r.name) || r.address;
}

/** 有备注时，备注旁边以灰色小字显示的服务器名称（与备注相同时不重复） */
export function serverSubtitle(r: Pick<RecentServer, 'note' | 'name'>): string {
  const note = r.note?.trim();
  const name = cleanServerName(r.name);
  return note && name && name !== note ? name : '';
}
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

/** 收藏的全部保留，其余的只留最近 MAX_RECENT 条（列表里最新的在前） */
function trim(list: RecentServer[]): RecentServer[] {
  let others = 0;
  return list.filter((r) => r.favorite || ++others <= MAX_RECENT);
}

export function loadRecent(storage: KeyValueStore): RecentServer[] {
  const list = storage.get<RecentServer[]>(KEY);
  if (Array.isArray(list)) return trim(list.filter((r) => r && typeof r.address === 'string' && r.address));
  const legacy = storage.get<string[]>(LEGACY_KEY);
  if (!Array.isArray(legacy)) return [];
  return legacy
    .filter((a) => typeof a === 'string' && a)
    .slice(0, MAX_RECENT)
    .map((address) => ({ address, name: '', at: 0 }));
}

/** 连接成功后记下这台服务器（放到最前面）；保留原来的收藏和备注 */
export function rememberServer(storage: KeyValueStore, entry: RecentServer): RecentServer[] {
  const address = withoutInvite(entry.address);
  const old = loadRecent(storage);
  const prev = findRecent(old, address);
  const merged: RecentServer = { ...entry, address, favorite: entry.favorite ?? prev?.favorite, note: entry.note ?? prev?.note, logo: entry.logo ?? prev?.logo };
  for (const k of ['favorite', 'note', 'nickname', 'password', 'logo'] as const) if (merged[k] === undefined || merged[k] === '' || merged[k] === false) delete merged[k];
  const list = trim([merged, ...old.filter((r) => !sameServer(r.address, address))]);
  storage.set(KEY, list);
  return list;
}

/** 修改一条记录（收藏、备注、昵称）；位置不变 */
export function updateServer(storage: KeyValueStore, address: string, patch: Partial<Pick<RecentServer, 'favorite' | 'note' | 'nickname' | 'logo' | 'name'>>): RecentServer[] {
  const list = trim(
    loadRecent(storage).map((r) => {
      if (r.address !== address) return r;
      const next: RecentServer = { ...r, ...patch };
      for (const k of ['favorite', 'note', 'nickname', 'logo'] as const) if (!next[k]) delete next[k];
      return next;
    }),
  );
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

/** 地址栏兼作搜索框：按备注、服务器名称、地址、昵称匹配（不区分大小写） */
export function matchesServer(r: RecentServer, query: string, defaultNickname = ''): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [r.note, r.name, r.address, r.nickname || defaultNickname].some((f) => !!f && f.toLowerCase().includes(q));
}

/** 看起来是一个完整的地址（带点、冒号、斜杠，或 localhost），而不是搜索词 */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim();
  return /[.:/]/.test(t) || /^localhost$/i.test(t);
}

/**
 * 在地址栏按回车（或点「连接」）时要连的服务器：正好是列表里的某一台就连它；
 * 输入的是完整地址就连这个地址；否则当作搜索词，连第一台匹配的服务器（matches 已按列表顺序过滤）
 */
export function connectTarget(list: readonly RecentServer[], matches: readonly RecentServer[], text: string): string {
  const t = text.trim();
  return findRecent(list, t)?.address ?? (looksLikeAddress(t) ? t : (matches[0]?.address ?? t));
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
