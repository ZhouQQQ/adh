import { spawn, type ChildProcess } from 'node:child_process';
import {
  ensureWdaForward,
  findWdaBundleId,
  probeWda,
  stopWdaForward,
  wdaPortFor,
  runCommand,
} from '@adh/device-host';

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
async function stopWda(udid: string): Promise<void> {
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
    await stopWda(udid);
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

