import { spawn, type ChildProcess } from 'node:child_process';
import { runCommand } from '@adh/device-host';

/**
 * 一键启动 WebDriverAgent。
 *
 * 优先使用环境变量里配置的已签名 WDA：
 *   ADH_WDA_BUNDLE_ID / ADH_WDA_TEST_BUNDLE_ID
 * 没配置时退回 go-ios 的 `ui run wda`（自动查找 / 下载 WDA）。
 */

const runners = new Map<string, ChildProcess>();
let commandCache: string | null = null;

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

export async function isWdaReady(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:8100/status', {
      signal: AbortSignal.timeout(1_200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startWda(
  udid: string,
): Promise<{ ok: boolean; message: string }> {
  if (await isWdaReady()) {
    return { ok: true, message: 'WDA 已在运行' };
  }

  const running = runners.get(udid);
  if (running && running.exitCode === null) {
    return { ok: false, message: 'WDA 正在启动，请稍候' };
  }

  const command = await resolveCommand();
  if (!command) {
    return { ok: false, message: '未找到 go-ios，请先安装后重试' };
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
    : ['ui', 'run', 'wda', '--host-port=8100'];

  const child = spawn(command, args, {
    windowsHide: true,
    stdio: 'ignore',
  });
  runners.set(udid, child);
  const cleanup = (): void => {
    runners.delete(udid);
  };
  child.on('exit', cleanup);
  child.on('error', cleanup);

  // 等待 8100 就绪，最多 45 秒
  for (let i = 0; i < 45; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (await isWdaReady()) {
      return { ok: true, message: 'WDA 已启动' };
    }
    if (child.exitCode !== null) {
      return {
        ok: false,
        message: 'WDA 启动失败，请确认手机已信任电脑并开启开发者模式',
      };
    }
  }
  return { ok: false, message: 'WDA 启动超时，请检查设备后手动启动' };
}

/**
 * 安装（或更新）WDA。
 * 需要先在服务端配置签名材料：
 *   ADH_WDA_P12 / ADH_WDA_PROFILE / ADH_WDA_P12_PASSWORD
 */
export async function installWda(
  udid: string,
): Promise<{ ok: boolean; message: string }> {
  const p12 = process.env.ADH_WDA_P12?.trim();
  const profile = process.env.ADH_WDA_PROFILE?.trim();
  if (!p12 || !profile) {
    return {
      ok: false,
      message:
        '未配置 WDA 签名材料：请设置 ADH_WDA_P12 和 ADH_WDA_PROFILE 后重启 server',
    };
  }

  const command = await resolveCommand();
  if (!command) {
    return { ok: false, message: '未找到 go-ios，请先安装' };
  }

  const args = [
    'ui',
    'install',
    'wda',
    `--udid=${udid}`,
    `--p12file=${p12}`,
    `--profile=${profile}`,
  ];
  const password = process.env.ADH_WDA_P12_PASSWORD?.trim();
  if (password) args.push(`--p12password=${password}`);

  const result = await runCommand(command, args, 180_000);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      message: detail || 'WDA 安装失败，请检查签名证书与描述文件',
    };
  }
  return {
    ok: true,
    message: 'WDA 已安装，请在手机上到「设置 → 通用 → VPN 与设备管理」信任证书',
  };
}