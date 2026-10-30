import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';

export type { Logger };

export function createLogger(level = 'info'): Logger {
  const stream = pretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'pid,hostname',
    singleLine: true,
  });
  return pino({ level, base: undefined }, stream);
}