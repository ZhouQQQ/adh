import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { runCommand } from './exec.js';

/**
 * WDA 自带 MJPEG server（设备端 9100）。
 * 用 go-ios 做端口转发，并管理转发进程的生命周期。
 *
 * server 和 agent 共用：谁插着设备，就在谁的进程里建转发。
 */

const forwards = new Map<string, { child: ChildProcess; port: number }>();
let commandCache: { at: number; command: string | null } | null = null;
let nextPort = 9100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function resolveCommand(): Promise<string | null> {
  if (commandCache && Date.now() - commandCache.at < 60_000) {
    return commandCache.command;
  }
  for (const candidate of ['ios', 'go-ios']) {
    const result = await runCommand(candidate, ['version'], 5_000);
    if (!result.failedToStart) {
      commandCache = { at: Date.now(), command: candidate };
      return candidate;
    }
  }
  commandCache = { at: Date.now(), command: null };
  return null;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 确保该设备有可用的本地 MJPEG 端口，返回端口号。 */
export async function ensureMjpegPort(udid: string): Promise<number | null> {
  const existing = forwards.get(udid);
  if (existing && (await portOpen(existing.port))) return existing.port;

  const command = await resolveCommand();
  if (!command) return null;

  let port = existing?.port ?? nextPort;
  if (!existing) {
    // 端口被其它设备的转发占用时换一个
    if (await portOpen(port)) port = nextPort + 1;
    nextPort = port + 1;
  }

  const child = spawn(
    command,
    ['forward', String(port), '9100', `--udid=${udid}`],
    { stdio: 'ignore', windowsHide: true },
  );
  existing?.child.kill();
  forwards.set(udid, { child, port });
  child.on('exit', () => {
    const current = forwards.get(udid);
    if (current?.child === child) forwards.delete(udid);
  });

  for (let i = 0; i < 25; i += 1) {
    if (await portOpen(port)) return port;
    await sleep(150);
  }

  child.kill();
  forwards.delete(udid);
  return null;
}

export function stopMjpegForward(udid: string): void {
  const entry = forwards.get(udid);
  if (!entry) return;
  forwards.delete(udid);
  if (entry.child.exitCode === null) {
    try {
      entry.child.kill();
    } catch {
      /* 进程可能已经退出 */
    }
  }
}

function shutdownMjpegForwards(): void {
  for (const { child } of forwards.values()) child.kill();
  forwards.clear();
}

process.on('exit', shutdownMjpegForwards);
process.on('SIGINT', shutdownMjpegForwards);
process.on('SIGTERM', shutdownMjpegForwards);

/* ------------------------------------------------------------------ */
/* MJPEG 流解析                                                        */
/* ------------------------------------------------------------------ */

export interface MjpegStreamHandle {
  stop(): void;
}

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/**
 * 连接 WDA 的 MJPEG 端点，按 `FFD8 ... FFD9` 切出完整 JPEG 帧。
 * 返回句柄，调用 stop() 断开。
 */
export async function openMjpegStream(
  port: number,
  onFrame: (jpeg: Buffer) => void,
  onError?: (message: string) => void,
): Promise<MjpegStreamHandle> {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`MJPEG ${response.status}`);
      }

      const reader = response.body.getReader();
      let buffer = Buffer.alloc(0);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer = Buffer.concat([buffer, Buffer.from(value)]);

        // 一帧就是一对 SOI/EOI，中间可能夹带 multipart 头，直接丢掉
        for (;;) {
          const start = buffer.indexOf(JPEG_START);
          if (start < 0) {
            // 保留最后 1 字节，避免 FFD8 被截断
            buffer = buffer.subarray(Math.max(0, buffer.length - 1));
            break;
          }
          const end = buffer.indexOf(JPEG_END, start + 2);
          if (end < 0) {
            if (start > 0) buffer = buffer.subarray(start);
            break;
          }
          const frame = buffer.subarray(start, end + 2);
          onFrame(Buffer.from(frame));
          buffer = buffer.subarray(end + 2);
        }

        // 防御：长时间没切出帧时丢弃积压
        if (buffer.length > 8 * 1024 * 1024) buffer = Buffer.alloc(0);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      onError?.(error instanceof Error ? error.message : String(error));
    }
  })();

  return {
    stop() {
      controller.abort();
    },
  };
}
