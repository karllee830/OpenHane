// 性能预算：网页版首屏 JS（index.html 直接引用的脚本，gzip 后）≤ 250 KB。
// 用法：npm run build && npm run budget
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_KB = 250;
const dist = join(dirname(fileURLToPath(import.meta.url)), '../apps/web/dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]+src="\.?\/?([^"]+\.js)"/g), ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\.?\/?([^"]+\.js)"/g)].map((m) => m[1]);
let total = 0;
for (const s of new Set(scripts)) {
  const kb = gzipSync(readFileSync(join(dist, s)), { level: 9 }).length / 1024;
  total += kb;
  console.log(`${s}  ${kb.toFixed(1)} KB (gzip)`);
}
console.log(`首屏 JS 合计 ${total.toFixed(1)} KB（预算 ${LIMIT_KB} KB）`);
if (total > LIMIT_KB) {
  console.error(`超出预算 ${(total - LIMIT_KB).toFixed(1)} KB`);
  process.exit(1);
}
