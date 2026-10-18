// 构建桌面版：主进程 / 预加载脚本 / 热键进程打成 CommonJS（Node 目标），渲染进程用与 Web 版相同的 Vite 配置。
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // 网络共享（SMB）上删除目录偶尔会延迟，需要重试

for (const [entry, name] of [
  ['src/main/main.ts', 'main'],
  ['src/preload/preload.ts', 'preload'],
  ['src/hotkeys/worker.ts', 'hotkeys'],
]) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: resolve(root, entry),
      outDir: out,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        external: ['electron', 'uiohook-napi', /^node:/],
        output: { format: 'cjs', entryFileNames: `${name}.cjs` },
      },
    },
    ssr: { noExternal: true },
  });
}

await build({
  root: resolve(root, 'src/renderer'),
  configFile: false,
  base: './',
  define: { __APP_BUILD__: JSON.stringify(process.env.HANE_BUILD ?? '') },
  plugins: [react(), tailwindcss()],
  logLevel: 'warn',
  build: { outDir: resolve(out, 'renderer'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 6000 },
  worker: { format: 'es' },
});
console.log('desktop build ok →', out);
