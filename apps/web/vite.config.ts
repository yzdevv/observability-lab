import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the page talks to the dev gateway; in production nginx proxies /api/.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.GATEWAY_URL ?? 'http://127.0.0.1:8088' },
  },
  build: { target: 'es2022', sourcemap: false },
});
