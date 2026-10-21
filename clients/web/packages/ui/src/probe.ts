// 服务器列表的状态：延迟、在线人数和图标（GET /api/v1/info、/api/v1/logo，服务端允许跨域读取）。
// 服务端返回的内容一律不信任：限制读取的字节数、不跟随重定向，图标先校验文件头（PNG、尺寸）再显示。
import { candidateAddresses, hostPort, parseAddress, readLimited, type ServerAddress } from '@hane/core';
import { useEffect, useState } from 'react';
import { cleanServerName } from './recent';
import { useServices } from './services';

export { readLimited };

export interface ServerStatus {
  /** 往返延迟（毫秒）；null 表示连不上 */
  ms: number | null;
  /** 在线人数；旧版本服务器不提供 */
  online?: number;
  /** 服务器图标的地址（服务器设置了图标时；地址里带上摘要，换了图标地址就变） */
  logo?: string;
  /** 服务器名称（清洗过；默认名称当作没有） */
  name?: string;
}

const TIMEOUT_MS = 4000;
/** info 的大小上限（正常只有一两百字节） */
const INFO_MAX_BYTES = 64 << 10;
/** 图标的大小上限，以及允许的最大边长（服务端给的是 512 以内的 PNG） */
const LOGO_MAX_BYTES = 1 << 20;
const LOGO_MAX_SIDE = 1024;

/** info 里的 logo 字段换成图标地址：必须是十六进制摘要，否则当作没有图标 */
export function logoUrl(hash: unknown, infoUrl: string): string | undefined {
  return typeof hash === 'string' && /^[0-9a-f]{8,64}$/.test(hash) ? new URL(`logo?v=${hash}`, infoUrl).href : undefined;
}

/** 是不是 PNG，且宽高在 1–maxSide 之间（只看文件头，不解码） */
export function isSafePng(b: Uint8Array, maxSide = LOGO_MAX_SIDE): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v)) return false;
  // 第一个块必须是 IHDR，宽高是紧跟其后的两个大端 32 位整数
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = v.getUint32(16);
  const h = v.getUint32(20);
  return w >= 1 && h >= 1 && w <= maxSide && h <= maxSide;
}
/** 列表显示期间每隔多久重新测一次 */
const REFRESH_MS = 30_000;

export async function fetchInfo(url: string): Promise<{ name?: unknown; requires_password?: unknown; online?: unknown; logo?: unknown }> {
  const r = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(String(r.status));
  const j: unknown = JSON.parse(new TextDecoder().decode(await readLimited(r, INFO_MAX_BYTES)));
  return j && typeof j === 'object' ? j : {};
}

/** 测一个具体的端口：第一次请求要建立 TCP / TLS 连接，延迟取复用连接的第二次请求 */
async function probeUrl(url: string): Promise<ServerStatus> {
  await fetchInfo(url);
  const t0 = performance.now();
  const info = await fetchInfo(url);
  return {
    ms: Math.max(1, Math.round(performance.now() - t0)),
    online: typeof info.online === 'number' ? info.online : undefined,
    logo: logoUrl(info.logo, url),
    name: cleanServerName(info.name),
  };
}

/**
 * 测一台服务器。地址里没写端口时与连接时一样同时尝试几个候选端口，用最先响应的。
 * checkCert（桌面版）：证书指纹和记住的不一致时不发请求，按连不上显示；警告留到用户点「连接」时再弹
 */
export async function probeServer(address: string, checkCert?: (hostPort: string) => Promise<boolean>): Promise<ServerStatus> {
  let candidates: ServerAddress[];
  try {
    candidates = candidateAddresses(parseAddress(address));
  } catch {
    return { ms: null };
  }
  const probeOne = async (a: ServerAddress) => {
    if (a.secure && checkCert && !(await checkCert(hostPort(a)))) throw new Error('certificate fingerprint changed');
    return probeUrl(`${a.secure ? 'https' : 'http'}://${hostPort(a)}/api/v1/info`);
  };
  return Promise.any(candidates.map(probeOne)).catch(() => ({ ms: null }));
}

/** 信号格数（1–4）；0 表示连不上 */
export function signalBars(ms: number | null): number {
  if (ms === null) return 0;
  return ms < 60 ? 4 : ms < 120 ? 3 : ms < 250 ? 2 : 1;
}

/** 列表里每台服务器的状态（undefined = 还在测），定期刷新 */
export function useServerStatus(addresses: readonly string[]): Record<string, ServerStatus | undefined> {
  const trust = useServices().platform.trust;
  const [status, setStatus] = useState<Record<string, ServerStatus | undefined>>({});
  const key = addresses.join('\n');
  useEffect(() => {
    let alive = true;
    const checkCert = trust?.check?.bind(trust);
    const run = () => {
      for (const a of addresses) void probeServer(a, checkCert).then((s) => alive && setStatus((prev) => ({ ...prev, [a]: s })));
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return status;
}

/** 已连接服务器的图标地址（会议页显示）；服务器没有设置图标或读不到时为空 */
export function useServerLogo(address: ServerAddress | null): string {
  const [logo, setLogo] = useState('');
  const url = address ? `${address.secure ? 'https' : 'http'}://${hostPort(address)}/api/v1/info` : '';
  useEffect(() => {
    setLogo('');
    if (!url) return;
    let alive = true;
    fetchInfo(url)
      .then((info) => alive && setLogo(logoUrl(info.logo, url) ?? ''))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url]);
  return logo;
}

/** 已下载并校验过的图标（地址 → 本地 Blob 地址；不合格时为空）。同一个图标只下载一次 */
const logoImages = new Map<string, Promise<string>>();

async function loadLogo(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(String(r.status));
  const bytes = await readLimited(r, LOGO_MAX_BYTES);
  if (!isSafePng(bytes)) throw new Error('not a valid logo');
  // 不管服务端声称是什么类型，都按 PNG 交给浏览器
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
}

/** 服务器图标：下载、校验后返回可以放进 <img> 的本地地址；没有图标或不合格时为空 */
export function useLogoImage(url: string | undefined): string {
  const [src, setSrc] = useState('');
  useEffect(() => {
    setSrc('');
    if (!url) return;
    let alive = true;
    let p = logoImages.get(url);
    if (!p) {
      p = loadLogo(url).catch(() => '');
      logoImages.set(url, p);
    }
    void p.then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [url]);
  return src;
}
