import { spawn, type ChildProcess } from 'node:child_process';
import type { IosTunnel, IosTunnelStatus } from '@adh/protocol';
import { runCommand } from './exec.js';

/**
 * 节点级 iOS 隧道管理（iOS 17+ 依赖 go-ios 的 `ios tunnel start`）。
 *
 * server 内置 Agent 和外接 Agent 共用这一份逻辑：
 * - 发现设备前自动确保隧道在跑
 * - 控制台可以手动启动 / 停止并查看状态
 *
 * Windows 上启动需要管理员权限（创建 TUN 网卡）和 wintun.dll，
 * 失败原因会记到 `error` 里透传到界面。
 */

const ERROR_LIMIT = 4_096;

let tunnelProcess: ChildProcess | null = null;
let lastError: string | undefined;
let commandCache: { at: number; command: string | null } | null = null;

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

function parseJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function summarizeFailure(raw: string): string | undefined {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const text = lines.slice(-3).join(' · ');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 查询当前节点上已建立的隧道（`ios tunnel ls`）。 */
export async function probeTunnels(): Promise<IosTunnel[]> {
  const command = await resolveCommand();
  if (!command) return [];

  const result = await runCommand(command, ['tunnel', 'ls'], 10_000);
  if (result.code !== 0) return [];

  const list = parseJsonArray(result.stdout);
  if (!list) return [];

  return list
    .map((item) => {
      const entry = item as {
        udid?: unknown;
        address?: unknown;
        rsdPort?: unknown;
      };
      if (typeof entry.udid !== 'string') return null;
      const tunnel: IosTunnel = { udid: entry.udid };
      if (typeof entry.address === 'string') tunnel.address = entry.address;
      if (typeof entry.rsdPort === 'number') tunnel.rsdPort = entry.rsdPort;
      return tunnel;
    })
    .filter((tunnel): tunnel is IosTunnel => tunnel !== null);
}

export async function getTunnelStatus(): Promise<IosTunnelStatus> {
  const tunnels = await probeTunnels();
  return {
    running:
      Boolean(tunnelProcess && tunnelProcess.exitCode === null) ||
      tunnels.length > 0,
    tunnels,
    error: lastError,
    updatedAt: Date.now(),
  };
}

/** 启动 `ios tunnel start`；已在运行则直接返回当前状态。 */
export async function startTunnel(): Promise<IosTunnelStatus> {
  if (tunnelProcess && tunnelProcess.exitCode === null) {
    return getTunnelStatus();
  }

  const command = await resolveCommand();
  if (!command) {
    lastError = '未找到 go-ios（ios / go-ios），无法启动 iOS 隧道';
    return getTunnelStatus();
  }

  lastError = undefined;
  let stderr = '';
  const child = spawn(command, ['tunnel', 'start'], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  tunnelProcess = child;

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-ERROR_LIMIT);
  });

  const startedAt = Date.now();
  const cleanup = (): void => {
    if (tunnelProcess === child) tunnelProcess = null;
    // 刚起来就退出基本可以判定是权限 / wintun 问题
    if (Date.now() - startedAt < 5_000) {
      lastError =
        summarizeFailure(stderr) ??
        'tunnel start 启动后立即退出：Windows 需要管理员权限，并把 wintun.dll 放到 C:\\Windows\\System32';
    }
  };
  child.on('exit', cleanup);
  child.on('error', (error) => {
    lastError = error.message;
    cleanup();
  });

  // 给进程一点时间完成初始化 / 暴露早期失败
  await sleep(2_000);
  return getTunnelStatus();
}

/** 停止隧道：先结束本模块拉起的进程，再清理 go-ios 的 tunnel agent。 */
export async function stopTunnel(): Promise<IosTunnelStatus> {
  const child = tunnelProcess;
  tunnelProcess = null;
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 进程可能已经退出 */
    }
  }

  const command = await resolveCommand();
  if (command) {
    await runCommand(command, ['tunnel', 'stopagent'], 10_000);
  }

  lastError = undefined;
  await sleep(500);
  return getTunnelStatus();
}

/** 发现设备前确保隧道在跑；失败原因由 getTunnelStatus 透出。 */
export async function ensureTunnelRunning(): Promise<void> {
  if (tunnelProcess && tunnelProcess.exitCode === null) return;
  const tunnels = await probeTunnels();
  if (tunnels.length > 0) return;
  await startTunnel();
}

export function hasTunnelProcess(): boolean {
  return Boolean(tunnelProcess && tunnelProcess.exitCode === null);
}