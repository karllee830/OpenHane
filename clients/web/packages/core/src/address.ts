// 地址栏解析。暂不支持 SRV 记录查询。

export const DEFAULT_PORT = 9800;

/** 地址里没写端口（也没写协议）时依次尝试的端口，排在前面的优先 */
export const FALLBACK_PORTS = [DEFAULT_PORT, 443];

export interface ServerAddress {
  host: string; // IPv6 不带方括号
  port: number;
  /** 通过网页邀请链接解析出的邀请码 */
  invite?: string;
  /** 是否使用 TLS（wss）。只有显式写 http:// / ws:// 时为 false（本机开发、反向代理之后） */
  secure: boolean;
  /** 没写协议也没写端口：连接时同时尝试 FALLBACK_PORTS，port 只是第一个候选 */
  portImplicit?: boolean;
}

export class AddressError extends Error {}

export function parseAddress(input: string): ServerAddress {
  let s = input.trim();
  if (!s) throw new AddressError('empty address');
  let secure = true;
  let invite: string | undefined;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (!['https', 'http', 'wss', 'ws', 'openhane'].includes(proto)) throw new AddressError(`unsupported scheme ${proto}`);
    secure = proto !== 'http' && proto !== 'ws';
    const url = new URL(proto === 'openhane' ? 'https://' + s.slice(scheme[0].length) : s);
    const m = /^\/j\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    if (m) invite = m[1];
    invite ??= url.searchParams.get('invite') ?? undefined;
    const port = url.port ? Number(url.port) : proto === 'openhane' ? DEFAULT_PORT : secure ? 443 : 80;
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port, invite, secure };
  }

  // 去掉路径部分
  s = s.replace(/\/.*$/, '');
  let host: string;
  let port = DEFAULT_PORT;
  let portImplicit = true;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(s);
  if (v6) {
    host = v6[1]!;
    if (v6[2]) {
      port = Number(v6[2]);
      portImplicit = false;
    }
  } else if ((s.match(/:/g) ?? []).length > 1) {
    host = s; // 裸 IPv6，没有端口
  } else {
    const [h, p] = s.split(':');
    host = h!;
    if (p !== undefined) {
      if (!/^\d+$/.test(p)) throw new AddressError('invalid port');
      port = Number(p);
      portImplicit = false;
    }
  }
  if (!host || port < 1 || port > 65535) throw new AddressError('invalid address');
  return portImplicit ? { host, port, invite, secure, portImplicit } : { host, port, invite, secure };
}

/** 连接时要尝试的地址，按优先级排列 */
export function candidateAddresses(a: ServerAddress): ServerAddress[] {
  return a.portImplicit ? FALLBACK_PORTS.map((port) => ({ ...a, port })) : [a];
}

export function hostPort(a: ServerAddress): string {
  return `${a.host.includes(':') ? `[${a.host}]` : a.host}:${a.port}`;
}

/** 控制协议地址 */
export function controlUrl(a: ServerAddress): string {
  return `${a.secure ? 'wss' : 'ws'}://${hostPort(a)}/ws`;
}

/** HTTP 接口地址（聊天图片等）：与控制连接同一 host:port */
export function httpBase(a: ServerAddress): string {
  return `${a.secure ? 'https' : 'http'}://${hostPort(a)}`;
}

/** 媒体（LiveKit）地址：与控制连接同一 host:port */
export function mediaUrl(a: ServerAddress): string {
  return `${a.secure ? 'wss' : 'ws'}://${hostPort(a)}`;
}

/** 便于展示的地址（默认端口省略） */
export function displayAddress(a: ServerAddress): string {
  return a.port === DEFAULT_PORT ? (a.host.includes(':') ? `[${a.host}]` : a.host) : hostPort(a);
}
