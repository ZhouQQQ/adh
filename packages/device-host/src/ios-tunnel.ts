import { spawn, type ChildProcess } from 'node:child_process';
import type { IosTunnel, IosTunnelStatus } from '@adh/protocol';
import { runCommand } from './exec.js';
import { logInfo, logWarn } from './log.js';

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

/** 上一次打印过的隧道数量，避免每轮发现都重复输出「复用」日志。 */
let lastLoggedTunnels = 0;
/** 启动失败后的重试时间，避免每轮设备发现都重复拉起、刷日志。 */
let tunnelRetryAt = 0;
/** 用户手动停止后，不再由设备发现自动拉起；手动启动或进程重启后恢复。 */
let tunnelPaused = false;
/** 启动过程中避免设备发现并发触发第二次 start。 */
let tunnelStarting = false;

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

/** Windows 普通权限无法创建 kernel 隧道时，回退到用户态隧道。 */
function needsElevation(text: string): boolean {
  return /elevated privileges|administrator|sudo|CAP_NET_ADMIN/i.test(text);
}

async function startTunnelProcess(userspace: boolean): Promise<IosTunnelStatus> {
  const command = await resolveCommand();
  if (!command) {
    lastError = '未找到 go-ios（ios / go-ios），无法启动 iOS 隧道';
    logWarn(`[ios] ${lastError}`);
    return getTunnelStatus();
  }

  lastError = undefined;
  const args = userspace ? ['tunnel', 'start', '--userspace'] : ['tunnel', 'start'];
  logInfo(`[ios] 正在启动 iOS 隧道（${command} ${args.join(' ')}）`);
  let stderr = '';
  const child = spawn(command, args, {
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
  await sleep(3_000);
  const status = await getTunnelStatus();
  if (!status.running && !userspace && needsElevation(stderr)) {
    logWarn('[ios] 当前进程没有管理员权限，改用用户态隧道重试');
    return startTunnelProcess(true);
  }
  if (status.running) {
    lastLoggedTunnels = status.tunnels.length;
    logInfo(
      status.tunnels.length > 0
        ? `[ios] iOS 隧道已启动（${status.tunnels.length} 条隧道）`
        : '[ios] iOS 隧道进程已拉起，等待设备连接',
    );
  } else {
    logWarn(`[ios] iOS 隧道启动失败：${status.error ?? '未知原因'}`);
  }
  return status;
}

/** 启动 `ios tunnel start`；已在运行则直接返回当前状态。 */
export async function startTunnel(): Promise<IosTunnelStatus> {
  // 手动启动视为恢复自动管理
  tunnelPaused = false;
  if (tunnelProcess && tunnelProcess.exitCode === null) {
    return getTunnelStatus();
  }
  // 正在启动时，设备发现的并发调用直接返回，避免重复 spawn
  if (tunnelStarting) return getTunnelStatus();
  tunnelStarting = true;
  try {
    return await startTunnelProcess(false);
  } finally {
    tunnelStarting = false;
  }
}

/** 停止隧道：先结束本模块拉起的进程，再清理 go-ios 的 tunnel agent。 */
export async function stopTunnel(): Promise<IosTunnelStatus> {
  // 用户主动停止：设备发现不再自动拉起，直到手动启动或 agent 重启
  tunnelPaused = true;
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
  // 等 go-ios agent 真正退出，避免接口返回「已停止但状态仍显示已连接」
  let status = await getTunnelStatus();
  const deadline = Date.now() + 3_000;
  while (status.running && Date.now() < deadline) {
    await sleep(300);
    status = await getTunnelStatus();
  }
  lastLoggedTunnels = 0;
  logInfo('[ios] iOS 隧道已停止');
  return status;
}

/** 发现设备前确保隧道在跑；失败原因由 getTunnelStatus 透出。 */
export async function ensureTunnelRunning(): Promise<void> {
  if (tunnelPaused) return;
  if (tunnelProcess && tunnelProcess.exitCode === null) return;
  if (Date.now() < tunnelRetryAt) return;
  const tunnels = await probeTunnels();
  if (tunnels.length > 0) {
    // 外部已建立隧道（比如上一次 agent 留下的），直接复用
    if (tunnels.length !== lastLoggedTunnels) {
      lastLoggedTunnels = tunnels.length;
      logInfo(`[ios] 检测到已有 iOS 隧道（${tunnels.length} 条），直接复用`);
    }
    return;
  }
  lastLoggedTunnels = 0;
  const status = await startTunnel();
  tunnelRetryAt = status.running ? 0 : Date.now() + 30_000;
}

export function hasTunnelProcess(): boolean {
  return Boolean(tunnelProcess && tunnelProcess.exitCode === null);
}