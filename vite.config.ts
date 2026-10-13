import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.ts';
const backend = `http://127.0.0.1:${config.app.port}`;
const proxy: ProxyOptions = {
  target: backend,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (outgoing, incoming) => {
      // Forward same-origin dev UI writes while preserving rejection of foreign origins.
      if (incoming.headers.origin === `http://${incoming.headers.host}`) outgoing.setHeader('origin', backend);
    });
  },
};
export default defineConfig({
  root: fileURLToPath(new URL('./src/app/client', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../../../dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': proxy, '/files': proxy } },
});
