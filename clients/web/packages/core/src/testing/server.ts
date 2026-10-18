/// <reference types="node" />
// 测试辅助：编译并启动真实的 Go 服务端（TLS 关闭、不探测公网 IP），供集成测试使用。
// 设置 HANE_SKIP_SERVER_TESTS=1 可跳过这些测试（例如没有 Go 环境）。

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER_DIR = resolve(import.meta.dirname, '../../../../../../server');

export const skipServerTests = process.env.HANE_SKIP_SERVER_TESTS === '1';

let binary: string | undefined;
function buildServer(): string {
  if (process.env.HANE_SERVER_BIN) return process.env.HANE_SERVER_BIN;
  if (!binary) {
    // 固定位置、每次覆盖（Go 有编译缓存）：每次新建目录的话，一百多 MB 的二进制越积越多，会把磁盘占满
    const dir = join(tmpdir(), 'hane-bin');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, 'openhane');
    execFileSync('go', ['build', '-o', out, './cmd/openhane'], { cwd: SERVER_DIR, stdio: 'inherit' });
    binary = out;
  }
  return binary;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

export interface TestServer {
  /** TLS 关闭时为 http://127.0.0.1:<port>，自签名证书时为 https://… */
  address: string;
  port: number;
  adminToken: string;
  /** 证书指纹（SHA256:<base64>）；TLS 关闭时为空 */
  fingerprint: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const bin = buildServer();
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'hane-data-'));
  const proc: ChildProcess = spawn(bin, ['serve'], {
    env: {
      ...process.env,
      HANE_PORT: String(port),
      HANE_TCP_FALLBACK_PORT: '0',
      HANE_TLS_MODE: 'off',
      HANE_STUN_SERVERS: 'off',
      HANE_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const adminToken = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('server did not start:\n' + output)), 20_000);
    const onData = (d: Buffer) => {
      output += d.toString();
      const m = /HANE-[0-9A-Z-]{24}/.exec(output);
      if (m) {
        clearTimeout(timer);
        res(m[0]);
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => rej(new Error(`server exited (${code}):\n${output}`)));
  });
  const tls = (env.HANE_TLS_MODE ?? 'off') !== 'off';
  return {
    address: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    adminToken,
    fingerprint: /fingerprint="?(SHA256:[A-Za-z0-9+/=]+)/.exec(output)?.[1] ?? '',
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
