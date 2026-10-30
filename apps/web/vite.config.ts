import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const SERVER = process.env.ADH_SERVER_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});