import { spawn, type ChildProcess } from 'node:child_process';
import {
  ensureWdaForward,
  probeWda,
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

export async function startWda(
  udid: string,
  port = wdaPortFor(udid),
): Promise<WdaStartResult> {
  if (await probeWda(port)) {
    return { ok: true, message: `WDA 已在运行（端口 ${port}）`, port };
  }

  const running = runners.get(udid);
  if (running && running.exitCode === null) {
    return { ok: false, message: 'WDA 正在启动，请稍候', port };
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

  const bundleId = process.env.ADH_WDA_BUNDLE_ID?.trim();
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

