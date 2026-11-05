import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

const SERVER = process.env.ADH_SERVER_URL ?? 'http://127.0.0.1:8080';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 构建时写入页面的版本号：优先 ADH_VERSION（CI tag），否则 server package.json。 */
function readVersion(): string {
  const explicit = process.env.ADH_VERSION?.trim();
  if (explicit) return explicit.replace(/^v(?=\d)/i, '');
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(HERE, '..', 'server', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* 读不到就用 dev */
  }
  return 'dev';
}

const APP_VERSION = readVersion();
const BUILD_TIME = new Date().toISOString();

/**
 * 部署前缀，与 server 的 ADH_BASE_PATH 保持一致。
 * 例如 /adh：dev 页面在 http://localhost:5173/adh/，
 * 请求 /adh/api、/adh/ws 由 vite 代理到 server 的同名前缀。
 */
function readBasePath(): string {
  const raw = (process.env.ADH_BASE_PATH ?? '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

const basePath = readBasePath();

/**
 * 把前缀注入 index.html。
 *
 * 只在 dev 生效：生产构建的产物不能固化前缀，否则运行时 server 再注入一份，
 * 两段 `window.__ADH_BASE__` 脚本会互相覆盖（后出现的生效），
 * 表现为部署到 /adh 后路由仍然跳到根路径。
 */
function basePathPlugin(): Plugin {
  return {
    name: 'adh-base-path',
    apply: 'serve',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'base',
            attrs: { href: `${basePath}/` },
            injectTo: 'head-prepend',
          },
          {
            tag: 'script',
            children: `window.__ADH_BASE__=${JSON.stringify(basePath)}`,
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

/**
 * 本地 dev 默认走 HTTP（localhost 属于安全上下文，WebCodecs 可用）。
 *
 * 用局域网 IP 通过 http 访问时浏览器不会暴露 WebCodecs，
 * 安卓投屏会提示「无法解码」，这种场景设置 ADH_HTTPS=1 启用 HTTPS。
 * 自签证书首次访问需要点「继续前往」，之后就会记住。
 *
 * 前面有 frp / nginx 做 HTTPS 终止、转发到本机 5173 时保持默认 HTTP 即可。
 */
const useHttps = process.env.ADH_HTTPS === '1';

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

export default defineConfig(({ command }) => ({
  // 构建用相对路径，运行时靠 server 注入的 <base> 定位资源；
  // dev 直接用带前缀的绝对路径，HMR / 代理都按这个前缀走。
  base: command === 'build' ? './' : `${basePath}/`,
  define: {
    __ADH_VERSION__: JSON.stringify(APP_VERSION),
    __ADH_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    vue(),
    basePathPlugin(),
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
      [`${basePath}/api`]: { target: SERVER, changeOrigin: true, secure: false },
      [`${basePath}/ws`]: {
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
}));
