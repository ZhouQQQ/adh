import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { runCommand } from './exec.js';

/**
 * 一台宿主机可能接多台 iOS 设备，每台设备的 WDA 都要有独立的本地端口：
 *   device-1 -> 127.0.0.1:8100
 *   device-2 -> 127.0.0.1:8101
 * 端口按设备首次出现的顺序分配，进程内保持一致。
 *
 * 可用 ADH_WDA_PORT_BASE 改起始端口（默认 8100）。
 */

const BASE_PORT = Number(process.env.ADH_WDA_PORT_BASE ?? 8100) || 8100;

const ports = new Map<string, number>();
const usedPorts = new Set<number>();
const forwards = new Map<string, { child: ChildProcess; port: number }>();
const retryAt = new Map<string, number>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 取（或分配）该设备的本地 WDA 端口。纯内存映射，不启动任何进程。 */
export function wdaPortFor(udid: string): number {
  const existing = ports.get(udid);
  if (existing !== undefined) return existing;

  let port = BASE_PORT;
  while (usedPorts.has(port)) port += 1;
  usedPorts.add(port);
  ports.set(udid, port);
  return port;
}

/** 已分配则返回端口，从未分配过返回 null（不会新分配）。 */
export function wdaPortOf(udid: string): number | null {
  return ports.get(udid) ?? null;
}

export function isPortOpen(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 探测本地端口上的 WDA 是否真的在响应 /status。 */
export async function probeWda(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;

    // 端口上可能挂着失效的 forward，或 go-ios 的 DeviceKit 等其他服务；
    // 它们对未实现的路由也会返回 HTTP 200 + "Unhandled endpoint"。
    // 只有真正的 WDA 才会给出 ready/state。
    const body = (await response.json()) as {
      value?: { state?: string; ready?: boolean };
    };
    return body?.value?.ready === true || body?.value?.state === 'success';
  } catch {
    return false;
  }
}

let commandCache: { at: number; command: string | null } | null = null;

/** 安装 go-ios 后清掉命令探测缓存。 */
export function resetWdaCommandCache(): void {
  commandCache = null;
}

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

/**
 * 从设备已安装应用里找 WebDriverAgent runner 的 bundle id。
 *
 * 个人免费账号重签时，签名工具可能给 bundle id 追加/更换后缀，
 * 所以不能把 `ADH_WDA_BUNDLE_ID` 当成固定值；配置缺失时以设备为准。
 * 找不到（还没装 WDA）返回 null。
 */
export async function findWdaBundleId(udid: string): Promise<string | null> {
  const command = await resolveCommand();
  if (!command) return null;

  const result = await runCommand(command, ['apps', `--udid=${udid}`], 15_000);
  if (result.code !== 0) return null;

  // `ios apps` 输出是 JSON 数组，可能混入日志行
  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return null;

  let apps: unknown;
  try {
    apps = JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(apps)) return null;

  const entries = apps as Array<{
    CFBundleIdentifier?: unknown;
    CFBundleExecutable?: unknown;
  }>;

  // 改 bundle id 时签名工具不会改二进制名，这是最稳的锚点；
  // bundle id 只用来兜底（com.facebook.* / com.xiaoan.* 都可能出现）
  const executableMatch = entries.find(
    (app) => app.CFBundleExecutable === 'WebDriverAgentRunner-Runner',
  )?.CFBundleIdentifier;

  if (typeof executableMatch === 'string' && executableMatch) {
    return executableMatch;
  }

  const ids = entries
    .map((app) => app.CFBundleIdentifier)
    .filter(
      (id): id is string =>
        typeof id === 'string' && id.includes('WebDriverAgentRunner'),
    );

  // 优先 xctrunner（runner app），而不是同名的 xctest 插件
  return ids.find((id) => id.includes('xctrunner')) ?? ids[0] ?? null;
}

export function stopWdaForward(udid: string): void {
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

/**
 * 确保该设备有一条 `本地端口 -> 设备 8100` 的转发。
 * 设备上 WDA 已经在跑、只是没转发时，这一步就能让它立即可用。
 * @returns 可用的本地端口；失败返回 null
 */
export async function ensureWdaForward(
  udid: string,
  port = wdaPortFor(udid),
  force = false,
): Promise<number | null> {
  const existing = forwards.get(udid);
  if (existing && existing.port === port && (await isPortOpen(port))) {
    return port;
  }
  if (existing) stopWdaForward(udid);

  // 端口已经能打开：可能是别的进程建的转发，或 WDA 直接监听在本机
  if (await isPortOpen(port)) return port;

  // 刚失败过就先退避，避免设备发现时反复拉起进程；
  // 手动点「启动」时传 force 跳过退避
  if (!force && Date.now() < (retryAt.get(udid) ?? 0)) return null;

  const command = await resolveCommand();
  if (!command) return null;

  const child = spawn(command, ['forward', String(port), '8100', `--udid=${udid}`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  forwards.set(udid, { child, port });

  const startedAt = Date.now();
  const cleanup = (): void => {
    const current = forwards.get(udid);
    if (current?.child === child) forwards.delete(udid);
    // 刚起来就退出多半是端口被占用或设备端没有监听
    if (Date.now() - startedAt < 3_000) {
      retryAt.set(udid, Date.now() + 30_000);
    }
  };
  child.on('exit', cleanup);
  child.on('error', cleanup);

  for (let i = 0; i < 25; i += 1) {
    if (await isPortOpen(port)) {
      retryAt.delete(udid);
      return port;
    }
    if (child.exitCode !== null) return null;
    await sleep(150);
  }

  stopWdaForward(udid);
  retryAt.set(udid, Date.now() + 30_000);
  return null;
}

/** 设备断开时清掉它的转发与端口占用，端口可留给新设备。 */
export function releaseWdaPort(udid: string): void {
  stopWdaForward(udid);
  const port = ports.get(udid);
  ports.delete(udid);
  retryAt.delete(udid);
  if (port !== undefined) usedPorts.delete(port);
}

function shutdownAll(): void {
  for (const { child } of forwards.values()) child.kill();
  forwards.clear();
}

process.on('exit', shutdownAll);
process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);