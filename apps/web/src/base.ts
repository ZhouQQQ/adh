/**
 * 部署前缀（例如 /adh）。
 *
 * 由 server 在返回 index.html 时注入 window.__ADH_BASE__，
 * 本地 dev 由 vite 插件注入，所以同一个镜像可以部署到任意路径。
 * 空串表示部署在根路径，默认如此。
 */
declare global {
  interface Window {
    __ADH_BASE__?: string;
  }
}

function normalize(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

export const BASE_PATH = normalize(
  typeof window === 'undefined' ? '' : window.__ADH_BASE__,
);

/** 给站内绝对路径加前缀：withBase('/api/health') → /adh/api/health */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** 浏览器 WebSocket 地址：ws(s)://host<prefix>/ws/... */
export function wsUrl(path: string, query?: Record<string, string>): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${protocol}://${window.location.host}${withBase(path)}${search}`;
}
