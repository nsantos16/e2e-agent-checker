import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/team/client', import.meta.url)),
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './routes',
      generatedRouteTree: './routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
  ],
  build: { outDir: '../../../dist/team', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api/team': `http://127.0.0.1:${process.env.TEAM_PORT ?? 4200}` },
  },
});
