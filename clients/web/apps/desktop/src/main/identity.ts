// 主种子的存储：用 Electron safeStorage 加密后存文件
// （Windows：DPAPI；macOS：钥匙串；Linux：libsecret）。系统没有可用的密钥环时退回明文文件（权限 0600）。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';

interface SeedFile {
  v: 1;
  encrypted: boolean;
  data: string; // base64
}

export function loadOrCreateSeed(file: string, log: (msg: string) => void): Uint8Array {
  try {
    const f = JSON.parse(readFileSync(file, 'utf8')) as SeedFile;
    const raw = Buffer.from(f.data, 'base64');
    const seed = f.encrypted ? Buffer.from(safeStorage.decryptString(raw), 'base64') : raw;
    if (seed.length === 32) return new Uint8Array(seed);
    log('identity file has unexpected length; generating a new identity');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`cannot read identity file (${String(e)}); generating a new identity`);
  }
  const seed = randomBytes(32);
  const encrypted = safeStorage.isEncryptionAvailable();
  if (!encrypted) log('safeStorage unavailable: identity stored unencrypted (file mode 0600)');
  const data = encrypted ? safeStorage.encryptString(seed.toString('base64')).toString('base64') : seed.toString('base64');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, encrypted, data } satisfies SeedFile), { mode: 0o600 });
  return new Uint8Array(seed);
}
