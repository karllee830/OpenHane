/// <reference types="node" />
// 构建 Web 客户端 → 复制到服务端的嵌入目录 → 编译服务端（带 Web 客户端）。
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..');
const ROOT = resolve(WEB, '../../../..');
const EMBED = join(ROOT, 'server/internal/webui/dist');

export default function globalSetup() {
  // 桌面版（Electron）的构建产物
  if (!process.env.HANE_SKIP_DESKTOP_BUILD) execFileSync('npm', ['run', 'build', '-w', '@hane/desktop'], { cwd: resolve(WEB, '../..'), stdio: 'inherit' });
  if (process.env.HANE_SERVER_BIN) return; // 外部已经提供了带 Web 客户端的服务端
  execFileSync('npm', ['run', 'build'], { cwd: WEB, stdio: 'inherit', env: { ...process.env, HANE_VERSION: 'e2e' } });
  // 网络共享（SMB）上偶尔报 ENOTEMPTY：重试几次
  for (const f of readdirSync(EMBED)) if (!f.startsWith('.')) rmSync(join(EMBED, f), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  cpSync(join(WEB, 'dist'), EMBED, { recursive: true });
  // 固定位置、每次覆盖（每次新建目录的话二进制越积越多，会把磁盘占满）
  const dir = join(tmpdir(), 'hane-e2e');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'openhane');
  execFileSync('go', ['build', '-o', bin, './cmd/openhane'], { cwd: join(ROOT, 'server'), stdio: 'inherit' });
  process.env.HANE_SERVER_BIN = bin;
}
