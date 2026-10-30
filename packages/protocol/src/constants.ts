/** 协议版本，两端不匹配时 server 拒绝连接并提示升级。 */
export const PROTOCOL_VERSION = 1;

/** server 默认端口。 */
export const DEFAULT_SERVER_PORT = 8080;

/** agent 心跳间隔（秒）。 */
export const AGENT_HEARTBEAT_SEC = 15;

/** server 判定 agent 掉线的超时（秒）。 */
export const AGENT_TIMEOUT_SEC = 45;

/** 投屏中继：单个 viewer 的发送缓冲上限，超过则丢弃 delta 帧。 */
export const VIEWER_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export const WS_PATHS = {
  agent: '/ws/agent',
  web: '/ws/web',
  stream: '/ws/stream',
} as const;