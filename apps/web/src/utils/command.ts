/**
 * 生成接入命令。dev 模式下页面在 5173，但 agent 必须连 server 端口，
 * 因此端口取自 /api/server-info。
 */
export function buildConnectCommand(key: string, serverPort: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname || '127.0.0.1';
  return `adh-agent connect --server ${protocol}://${host}:${serverPort} --key ${key}`;
}