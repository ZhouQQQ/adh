import http from 'node:http';
import basicSsl from '@vitejs/plugin-basic-ssl';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

const SERVER = process.env.ADH_SERVER_URL ?? 'http://127.0.0.1:8080';

/**
 * 本地 dev 默认走 HTTPS。
 *
 * 浏览器只在安全上下文（https / localhost）暴露 WebCodecs，
 * 用局域网 IP 走 http 打开时安卓投屏会提示「无法解码」。
 * 自签证书首次访问需要点「继续前往」，之后就会记住。
 *
 * ADH_HTTPS=0 可切回 http：
 * 前面有 frp / nginx 已经做了 HTTPS 终止、转发到本机 5173 时用。
 */
const useHttps = process.env.ADH_HTTPS !== '0';

/**
 * 通过 frp / nginx 用域名访问时，Vite 会校验 Host 头并拦截请求：
 *   Blocked request. This host ("xxx") is not allowed.
 *
 * 默认放行所有域名（本机开发服务器）。需要收紧时设置：
 *   ADH_ALLOWED_HOSTS=adb.example.com,adh.example.com
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

/**
 * HTTPS 端口被 TLS 占用后，浏览器访问 http://<ip>:5173 会直接握手失败。
 * 这里额外监听一个 HTTP 端口，把请求 301 到 https://<host>:5173。
 *
 * 默认 5174，可用 ADH_HTTP_PORT 改；顺便尝试 80（无管理员权限时自动跳过）。
 */
function httpToHttpsPlugin(): Plugin {
  return {
    name: 'adh-http-to-https',
    apply: 'serve',
    configureServer(server) {
      const httpsPort = Number(server.config.server.port ?? 5173);
      const ports = [
        Number(process.env.ADH_HTTP_PORT ?? 5174),
        80,
      ].filter((port) => Number.isFinite(port) && port > 0);
      const listeners: http.Server[] = [];

      for (const port of ports) {
        const redirect = http.createServer((req, res) => {
          const rawHost = (req.headers.host ?? 'localhost').split(':')[0];
          const location = `https://${rawHost}:${httpsPort}${req.url ?? '/'}`;
          res.writeHead(301, {
            location,
            'cache-control': 'no-store',
          });
          res.end();
        });

        // 端口被占用或没有权限（80 在 Windows 上常见）时静默跳过
        redirect.on('error', () => undefined);
        redirect.listen(port, '0.0.0.0', () => {
          listeners.push(redirect);
          server.config.logger.info(
            `http → https: http://<host>:${port} 会跳转到 https://<host>:${httpsPort}`,
          );
        });
      }

      server.httpServer?.on('close', () => {
        for (const listener of listeners) listener.close();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    ...(useHttps ? [basicSsl(), httpToHttpsPlugin()] : []),
  ],
  server: {
    // 监听所有网卡，方便用局域网 IP 访问（默认只绑 localhost）
    host: '0.0.0.0',
    port: 5173,
    // 自签证书换域名时也允许（仅开发环境）
    strictPort: true,
    allowedHosts: resolveAllowedHosts(),
    proxy: {
      '/api': { target: SERVER, changeOrigin: true, secure: false },
      '/ws': {
        target: SERVER.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
