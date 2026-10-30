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