import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';

export type { Logger };

export function createLogger(level = 'info'): Logger {
  const stream = pretty({
    // 后台运行（-d）时 stdout 是日志文件，不要写入 ANSI 颜色码
    colorize: Boolean(process.stdout.isTTY),
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
    ignore: 'pid,hostname',
    singleLine: true,
  });
  return pino({ level, base: undefined }, stream);
}