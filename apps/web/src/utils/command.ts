import { BASE_PATH } from '../base';

/**
 * 生成 Agent 接入命令。
 *
 * - 页面与 server 同源（含 nginx 反代到域名 / 子路径）：沿用页面协议和 host
 * - dev 模式页面在 5173/5174、server 在 8080：直连 server 端口，用 ws
 *
 * 部署在子路径时命令里也要带上同样的前缀，例如 ws://host/adh。
 */
export function buildConnectCommand(key: string, serverPort: number): string {
  const pagePort = window.location.port;
  const sameOrigin = !pagePort || pagePort === String(serverPort);
  const protocol = sameOrigin && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = sameOrigin
    ? window.location.host
    : `${window.location.hostname || '127.0.0.1'}:${serverPort}`;
  return `adh-agent connect --server ${protocol}://${host}${BASE_PATH} --key ${key}`;
}
