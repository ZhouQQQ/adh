export function formatAgo(timestamp: number, now = Date.now()): string {
  if (timestamp <= 0) return '从未';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 已经持续了多久：固定返回「X 分钟」，不用「刚刚」这类模糊说法。 */
export function formatDuration(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 内存按标称值归档：7.4GB → 8GB，5.6GB → 6GB。 */
export function memoryGb(memoryMb?: number): number | undefined {
  if (!memoryMb || memoryMb <= 0) return undefined;
  return Math.ceil(memoryMb / 1024);
}

export function formatMemory(memoryMb?: number): string {
  const gb = memoryGb(memoryMb);
  return gb ? `${gb} GB` : '—';
}

export function formatResolution(
  resolution?: { width: number; height: number },
): string {
  return resolution ? `${resolution.width}×${resolution.height}` : '—';
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}