// 服务器列表的状态：延迟和在线人数（GET /api/v1/info，服务端允许跨域读取）。
import { candidateAddresses, hostPort, parseAddress } from '@hane/core';
import { useEffect, useState } from 'react';

export interface ServerStatus {
  /** 往返延迟（毫秒）；null 表示连不上 */
  ms: number | null;
  /** 在线人数；旧版本服务器不提供 */
  online?: number;
}

const TIMEOUT_MS = 4000;
/** 列表显示期间每隔多久重新测一次 */
const REFRESH_MS = 30_000;

async function fetchInfo(url: string): Promise<{ online?: unknown }> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as { online?: unknown };
}

/** 测一个具体的端口：第一次请求要建立 TCP / TLS 连接，延迟取复用连接的第二次请求 */
async function probeUrl(url: string): Promise<ServerStatus> {
  await fetchInfo(url);
  const t0 = performance.now();
  const info = await fetchInfo(url);
  return { ms: Math.max(1, Math.round(performance.now() - t0)), online: typeof info.online === 'number' ? info.online : undefined };
}

/** 测一台服务器。地址里没写端口时与连接时一样同时尝试几个候选端口，用最先响应的 */
export async function probeServer(address: string): Promise<ServerStatus> {
  let urls: string[];
  try {
    urls = candidateAddresses(parseAddress(address)).map((a) => `${a.secure ? 'https' : 'http'}://${hostPort(a)}/api/v1/info`);
  } catch {
    return { ms: null };
  }
  return Promise.any(urls.map(probeUrl)).catch(() => ({ ms: null }));
}

/** 信号格数（1–4）；0 表示连不上 */
export function signalBars(ms: number | null): number {
  if (ms === null) return 0;
  return ms < 60 ? 4 : ms < 120 ? 3 : ms < 250 ? 2 : 1;
}

/** 列表里每台服务器的状态（undefined = 还在测），定期刷新 */
export function useServerStatus(addresses: readonly string[]): Record<string, ServerStatus | undefined> {
  const [status, setStatus] = useState<Record<string, ServerStatus | undefined>>({});
  const key = addresses.join('\n');
  useEffect(() => {
    let alive = true;
    const run = () => {
      for (const a of addresses) void probeServer(a).then((s) => alive && setStatus((prev) => ({ ...prev, [a]: s })));
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
