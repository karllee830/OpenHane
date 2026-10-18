import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(process.env.HANE_VERSION ?? 'dev'), __APP_BUILD__: JSON.stringify(process.env.HANE_BUILD ?? '') },
  // 产物嵌入服务端（server/internal/webui/dist），资源路径用相对路径，便于部署在反向代理的子路径下
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // RNNoise worklet 内嵌约 4.8 MB 的 wasm（base64），单独懒加载，不计入首屏
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: 'es' },
});
