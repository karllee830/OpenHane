// TOFU 证书固定：第一次见到自签名证书时记住其 SPKI 指纹，之后不一致即拒绝。
// 由 CA 签发的有效证书走 Chromium 的正常校验。
//
// 两道检查：
// 1. 预检（beforeConnect）：渲染进程每次建立控制连接前，主进程用 Node 的 TLS 连一次，取出证书指纹并按 TOFU 判断。
//    指纹不一致时直接拦下这次连接、弹出警告——Chromium 根本不会发起连接。
//    之所以不只靠 Chromium 的校验回调：网络服务会缓存校验结果，一旦回答过「失败」，
//    即使用户随后确认了新指纹，这张证书在缓存过期前也连不上；而挂起不回答又会让后续连接并入卡住的校验任务。
// 2. Chromium 的校验回调（setCertificateVerifyProc）：对所有连接（包括媒体）按记住的指纹校验，指纹不一致即拒绝，
//    防止预检之后证书被替换。
//
// 限制：Chromium 的校验回调只给出主机名，不含端口，所以指纹按主机名记录（同一主机上的多个服务器共用一条记录）。

import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { Session } from 'electron';

export function spkiOf(pem: string | Buffer): Buffer {
  const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest();
}

export const formatFingerprint = (spki: Buffer) => `SHA256:${spki.toString('base64')}`;

/** 主机名 → 指纹，保存在 userData/pins.json */
export class PinStore {
  private pins: Record<string, string> = {};
  constructor(private readonly file: string) {
    try {
      this.pins = JSON.parse(readFileSync(file, 'utf8')).pins ?? {};
    } catch {
      this.pins = {};
    }
  }
  get(host: string): string | undefined {
    return this.pins[host.toLowerCase()];
  }
  set(host: string, fp: string): void {
    this.pins[host.toLowerCase()] = fp;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pins: this.pins }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** 拆分 host:port（IPv6 带方括号） */
export function splitHostPort(hostPort: string): { host: string; port: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (v6) return { host: v6[1]!, port: Number(v6[2] ?? 443) };
  const i = hostPort.lastIndexOf(':');
  return i > 0 ? { host: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) } : { host: hostPort, port: 443 };
}

export type Verdict = { allowed: true } | { allowed: false; expected: string; actual: string };

/** 用 Node 的 TLS 连接取出服务器证书：SPKI 和是否由受信任的 CA 签发。连不上时返回 null。 */
export function probeCertificate(host: string, port: number, timeoutMs = 5000): Promise<{ spki: Buffer; authorized: boolean } | null> {
  return new Promise((resolve) => {
    const sock = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const done = (v: { spki: Buffer; authorized: boolean } | null) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.once('error', () => done(null));
    sock.once('secureConnect', () => {
      const cert = sock.getPeerX509Certificate();
      done(cert ? { spki: createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest(), authorized: sock.authorized } : null);
    });
  });
}

export class Tofu {
  /** 最近一次看到的 SPKI（按主机名），供鉴权签名使用 */
  private seen = new Map<string, Buffer>();

  constructor(
    private readonly ses: Session,
    private readonly pins: PinStore,
    private readonly onMismatch: (host: string, expected: string, actual: string) => void,
    private readonly probe = probeCertificate,
  ) {}

  install(): void {
    this.ses.setCertificateVerifyProc((req, cb) => {
      let spki: Buffer;
      try {
        spki = spkiOf(req.certificate.data);
      } catch {
        cb(-3); // 解析失败：交给 Chromium 的默认结果
        return;
      }
      const host = req.hostname.toLowerCase();
      this.seen.set(host, spki);
      if (req.errorCode === 0) {
        cb(-3); // CA 签发的有效证书：使用 Chromium 的校验结果
        return;
      }
      const fp = formatFingerprint(spki);
      const pinned = this.pins.get(host);
      if (!pinned) {
        this.pins.set(host, fp); // 首次使用即信任（通常已在预检时记住）
        cb(0);
      } else if (pinned === fp) {
        cb(0);
      } else {
        this.onMismatch(host, pinned, fp);
        cb(-2);
      }
    });
  }

  /** 建立控制连接前的预检（见文件头部说明）。 */
  async beforeConnect(hostPort: string): Promise<Verdict> {
    const { host: rawHost, port } = splitHostPort(hostPort);
    const host = rawHost.toLowerCase();
    const cert = await this.probe(rawHost, port);
    if (!cert) return { allowed: true }; // 连不上：让客户端得到正常的「无法连接」错误
    this.seen.set(host, cert.spki);
    if (cert.authorized) return { allowed: true };
    const fp = formatFingerprint(cert.spki);
    const pinned = this.pins.get(host);
    if (!pinned) {
      this.pins.set(host, fp);
      return { allowed: true };
    }
    if (pinned === fp) return { allowed: true };
    this.onMismatch(host, pinned, fp);
    return { allowed: false, expected: pinned, actual: fp };
  }

  seenSpki(hostPort: string): Buffer | null {
    return this.seen.get(splitHostPort(hostPort).host.toLowerCase()) ?? null;
  }

  /** 用户确认指纹变化是正常的：改为信任新指纹。 */
  accept(host: string, fingerprint: string): void {
    this.pins.set(host, fingerprint);
  }
}
