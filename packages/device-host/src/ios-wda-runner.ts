import { spawn, type ChildProcess } from 'node:child_process';
import {
  ensureWdaForward,
  findWdaBundleId,
  probeWda,
  stopWdaForward,
  wdaPortFor,
} from './ios-wda.js';
import { runCommand } from './exec.js';
import { logInfo, logWarn } from './log.js';

/**
 * 一键启动 WebDriverAgent（XCTest + 端口转发）。
 *
 * 一台宿主机可以接多台 iOS 设备：每台设备用自己的本地端口
 * （wdaPortFor(udid)，从 8100 开始按设备分配），互不覆盖。
 *
 * 优先使用环境变量里配置的已签名 WDA：
 *   ADH_WDA_BUNDLE_ID / ADH_WDA_TEST_BUNDLE_ID
 * 没配置时退回 go-ios 的 `ui run wda`（自动查找 / 下载 WDA，
 * 并通过 --host-port 同时建立转发）。
 *
 * server 和 agent 共用：谁插着设备就在谁那里执行。
 */

const runners = new Map<string, ChildProcess>();
let commandCache: string | null = null;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function resolveCommand(): Promise<string | null> {
  if (commandCache) return commandCache;
  for (const command of ['ios', 'go-ios']) {
    const result = await runCommand(command, ['version'], 5_000);
    if (!result.failedToStart) {
      commandCache = command;
      return command;
    }
  }
  return null;
}

export interface WdaStartResult {
  ok: boolean;
  message: string;
  port: number;
}

/** 该设备当前使用的本地 WDA 端口（不会启动进程）。 */
export function deviceWdaPort(udid: string): number {
  return wdaPortFor(udid);
}

/**
 * 等待 WDA 就绪。
 * needsForward=true 时（runwda 分支不会自己转发）定期补一条 `ios forward`。
 */
async function waitForWda(
  udid: string,
  port: number,
  child: ChildProcess | null,
  needsForward: boolean,
): Promise<WdaStartResult> {
  const deadline = Date.now() + 45_000;
  let lastForwardAt = 0;
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (child && child.exitCode !== null) {
      return {
        ok: false,
        message: 'WDA 启动失败，请确认手机已信任电脑并开启开发者模式',
        port,
      };
    }
    if (await probeWda(port)) {
      return { ok: true, message: `WDA 已启动（端口 ${port}）`, port };
    }
    if (needsForward && Date.now() - lastForwardAt > 5_000) {
      lastForwardAt = Date.now();
      await ensureWdaForward(udid, port, true);
      if (await probeWda(port)) {
        return { ok: true, message: `WDA 已启动（端口 ${port}）`, port };
      }
    }
  }
  return {
    ok: false,
    message: `WDA 启动超时，请检查设备后手动启动（端口 ${port}）`,
    port,
  };
}

/**
 * 停掉本机托管的 runwda / ui run wda 进程，并清理设备上残留的 runner。
 *
 * server 重启后 runners 里的 child 会丢，所以不能只 kill 子进程：
 * 再按进程名兜底杀一次设备上的 WebDriverAgentRunner-Runner。
 */
export async function stopWda(
  udid: string,
  pauseAuto = true,
): Promise<void> {
  // 用户主动停止后不再自动拉起，直到手动启动或 agent 重启
  if (pauseAuto) autoPaused.add(udid);
  const child = runners.get(udid);
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 进程可能已经退出 */
    }
  }
  runners.delete(udid);
  stopWdaForward(udid);

  const command = await resolveCommand();
  if (!command) return;

  const result = await runCommand(command, ['ps', `--udid=${udid}`], 10_000);
  if (result.code !== 0) return;

  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return;

  let processes: unknown;
  try {
    processes = JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return;
  }
  if (!Array.isArray(processes)) return;

  const pids = processes
    .filter(
      (proc) =>
        (proc as { Name?: unknown })?.Name === 'WebDriverAgentRunner-Runner',
    )
    .map((proc) => (proc as { Pid?: unknown }).Pid)
    .filter((pid): pid is number => typeof pid === 'number');

  for (const pid of pids) {
    await runCommand(command, ['kill', `--pid=${pid}`, `--udid=${udid}`], 5_000);
  }
}

export async function startWda(
  udid: string,
  port = wdaPortFor(udid),
  force = false,
): Promise<WdaStartResult> {
  // 手动启动视为恢复自动管理
  autoPaused.delete(udid);
  // force=true 表示「重启」：即使探测到旧实例也要先停掉再拉起，
  // 否则设备上的 XCTest 已经挂了、只剩一条失效转发时会被误判为「已在运行」。
  if (!force && (await probeWda(port))) {
    return { ok: true, message: `WDA 已在运行（端口 ${port}）`, port };
  }

  const running = runners.get(udid);
  if (running && running.exitCode === null) {
    if (!force) return { ok: false, message: 'WDA 正在启动，请稍候', port };
  }

  if (force) {
    // 重启是启动流程的一部分，不要因此暂停自动管理
    await stopWda(udid, false);
    // 给 testmanagerd 一点时间回收设备上的 XCTest 会话
    await sleep(1_000);
  }

  // 设备上的 WDA 可能已经在跑，只是没有端口转发：先补一条。
  // 这是用户主动操作，跳过失败退避。
  if (await ensureWdaForward(udid, port, true)) {
    if (await probeWda(port)) {
      return { ok: true, message: `WDA 已就绪（端口 ${port}）`, port };
    }
  }

  const command = await resolveCommand();
  if (!command) {
    return { ok: false, message: '未找到 go-ios，请先安装后重试', port };
  }

  // 重签后 bundle id 的前缀/后缀都可能变化（com.facebook.* / com.xiaoan.*），
  // 所以环境变量缺失时以设备上实际安装的 runner 为准。
  const configuredBundleId = process.env.ADH_WDA_BUNDLE_ID?.trim();
  const bundleId = configuredBundleId ?? (await findWdaBundleId(udid));
  const args = bundleId
    ? [
        'runwda',
        `--udid=${udid}`,
        `--bundleid=${bundleId}`,
        `--testrunnerbundleid=${process.env.ADH_WDA_TEST_BUNDLE_ID?.trim() || bundleId}`,
        '--xctestconfig=WebDriverAgentRunner.xctest',
      ]
    : ['ui', 'run', 'wda', `--udid=${udid}`, `--host-port=${port}`];

  const child = spawn(command, args, {
    windowsHide: true,
    stdio: 'ignore',
  });
  runners.set(udid, child);
  const cleanup = (): void => {
    if (runners.get(udid) === child) runners.delete(udid);
  };
  child.on('exit', cleanup);
  child.on('error', cleanup);

  // go-ios 的 `ui run wda` 自带 --host-port 转发；
  // runwda 只负责拉起 XCTest，需要我们自己补转发
  return waitForWda(udid, port, child, Boolean(bundleId));
}

/* ------------------------------------------------------------------ */
/* 自动启动：设备发现时后台补齐 WDA                                     */
/* ------------------------------------------------------------------ */

type WdaLogLevel = 'info' | 'warn';
type WdaLogger = (level: WdaLogLevel, message: string) => void;

export interface AutoStartOptions {
  /** 设备上已有外部 WDA 实例时，强制重启并由本 agent 接管。 */
  force?: boolean;
  log?: WdaLogger;
}

const AUTO_RETRY_BASE_MS = 60_000;
const AUTO_RETRY_MAX_MS = 10 * 60_000;

const autoQueue: { udid: string; force: boolean; log: WdaLogger }[] = [];
const autoQueued = new Set<string>();
const autoFailures = new Map<string, number>();
const autoRetryAt = new Map<string, number>();
/** 用户主动停止过的设备：不再自动拉起，手动启动或 agent 重启后恢复。 */
const autoPaused = new Set<string>();
let autoDraining = false;

function defaultWdaLog(level: WdaLogLevel, message: string): void {
  if (level === 'warn') logWarn(message);
  else logInfo(message);
}

/** 失败退避：60s 起指数增长，最多 10 分钟，避免每轮发现都重复拉起。 */
function scheduleAutoRetry(udid: string): void {
  const failures = (autoFailures.get(udid) ?? 0) + 1;
  autoFailures.set(udid, failures);
  const delay = Math.min(
    AUTO_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5),
    AUTO_RETRY_MAX_MS,
  );
  autoRetryAt.set(udid, Date.now() + delay);
}

async function drainAutoQueue(): Promise<void> {
  if (autoDraining) return;
  autoDraining = true;
  try {
    for (let item = autoQueue.shift(); item; item = autoQueue.shift()) {
      try {
        item.log(
          'info',
          item.force
            ? `[ios] ${item.udid} 检测到已有 WDA，正在重启并由 agent 接管`
            : `[ios] ${item.udid} 未检测到 WDA，正在自动启动`,
        );
        const result = await startWda(item.udid, undefined, item.force);
        if (result.ok) {
          autoFailures.delete(item.udid);
          autoRetryAt.delete(item.udid);
          item.log('info', `[ios] ${item.udid} 自动启动 WDA 成功：${result.message}`);
        } else {
          scheduleAutoRetry(item.udid);
          item.log('warn', `[ios] ${item.udid} 自动启动 WDA 失败：${result.message}`);
        }
      } catch (error) {
        scheduleAutoRetry(item.udid);
        item.log(
          'warn',
          `[ios] ${item.udid} 自动启动 WDA 异常：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        // 整个启动过程（含准备阶段）都占位，避免下一轮发现重复入队
        autoQueued.delete(item.udid);
      }
    }
  } finally {
    autoDraining = false;
  }
}

/**
 * 设备发现时自动尝试启动 WDA（XCTest）。
 *
 * - 多台 iOS 设备排队串行启动，避免同时抢占 testmanagerd；
 * - `startWda` 会先找设备上已安装的 WebDriverAgentRunner，找不到再走
 *   `ios ui run wda`，所以不需要额外探测；
 * - `force` 用于接管设备上已存在、但不是本 agent 拉起的 WDA 实例；
 * - 失败只写日志并指数退避重试，不抛异常、不阻塞设备发现。
 */
export function autoStartWda(
  udid: string,
  options: AutoStartOptions = {},
): void {
  if (autoPaused.has(udid)) return;
  if (autoQueued.has(udid)) return;
  if (Date.now() < (autoRetryAt.get(udid) ?? 0)) return;
  // 本 agent 已经在托管这台设备的 WDA，无需重复启动
  if (hasWdaRunner(udid)) return;
  autoQueued.add(udid);
  autoQueue.push({
    udid,
    force: Boolean(options.force),
    log: options.log ?? defaultWdaLog,
  });
  void drainAutoQueue();
}

/** 本 agent 进程是否托管着该设备的 WDA（用于区分外部已有实例）。 */
export function hasWdaRunner(udid: string): boolean {
  const child = runners.get(udid);
  return Boolean(child && child.exitCode === null);
}
