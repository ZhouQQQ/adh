import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { runCommand } from '@adh/device-host';

/**
 * WDA 自带 MJPEG server（设备端 9100）。
 * 这里用 go-ios 做端口转发，并管理转发进程的生命周期。
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

function shutdownMjpegForwards(): void {
  for (const { child } of forwards.values()) child.kill();
  forwards.clear();
}

process.on('exit', shutdownMjpegForwards);
process.on('SIGINT', shutdownMjpegForwards);
process.on('SIGTERM', shutdownMjpegForwards);