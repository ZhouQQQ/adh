/**
 * device-host 被 agent / server 共用，这里只做最简单的带时间戳输出，
 * 不依赖各自的 logger。格式与 agent 的 pino 日志保持一致：
 * [2026-11-05 10:07:44] [ios] ...
 */

function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  ].join(' ');
}

export function logInfo(message: string): void {
  console.log(`[${stamp()}] ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`[${stamp()}] ${message}`);
}