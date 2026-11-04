import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const SERVER = process.env.ADH_SERVER_URL ?? 'http://127.0.0.1:8080';

/**
 * 通过 frp / nginx 用域名访问时，Vite 会校验 Host 头并拦截请求：
 *   Blocked request. This host ("xxx") is not allowed.
 *
 * 默认放行所有域名（本机开发服务器）。需要收紧时设置：
 *   ADH_ALLOWED_HOSTS=yd.frp-bus.com,adh.example.com
 *   ADH_ALLOWED_HOSTS=strict   // 只允许 localhost 和 IP
 */
function resolveAllowedHosts(): true | string[] {
  const raw = (process.env.ADH_ALLOWED_HOSTS ?? '').trim();
  if (!raw || raw === 'all') return true;
  if (raw === 'strict') return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default defineConfig({
  plugins: [vue()],
  server: {
    // 监听所有网卡，方便用局域网 IP 访问（默认只绑 localhost）
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: resolveAllowedHosts(),
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
