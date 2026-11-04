import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  captureThumbnail,
  discoverAndroid,
  discoverIos,
  isAdbAvailable,
} from '@adh/device-host';
import {
  PROTOCOL_VERSION,
  type AgentCapability,
  type AgentRuntimeInfo,
  type DeviceInfo,
} from '@adh/protocol';
import { AgentClient } from './client.js';
import { runDoctor } from './doctor.js';
import { configFilePath, loadLocalConfig, saveLocalConfig } from './local-config.js';
import { createLogger, type Logger } from './log.js';
import { ThumbnailUploader } from './thumbnail-uploader.js';
import { ensureToolPath, runInit } from './tools.js';

/** 版本号：优先用打包时注入的 ADH_VERSION，其次读 package.json。 */
function readAgentVersion(): string {
  const injected = process.env.ADH_VERSION?.trim();
  // 统一成不带 v 的版本号，展示时再拼 "v"
  if (injected) return injected.replace(/^v(?=\d)/i, '');
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* 读不到就用默认值 */
  }
  return '0.1.0';
}

const AGENT_VERSION = readAgentVersion();
const THUMBNAIL_INTERVAL_MS = 30_000;

const HELP = `
adh-agent v${AGENT_VERSION}

用法:
  adh-agent init [--skip-ios] [--skip-android] [--force]
  adh-agent connect --server <ws://host:8080[/前缀]> [--key <接入Key>] [--name <宿主机名>]
  adh-agent doctor
  adh-agent version

说明:
  init     自动下载当前系统对应的 Android Platform Tools 与 go-ios 到 ~/.adh/tools
  connect  连接 adh-server 并持续上报本机设备
  doctor   检查 adb / go-ios / Apple 设备服务是否就绪

接入 Key 在 Web 控制台的「Agent 管理 → 新建 Agent」中生成；
server 部署在子路径时，--server 要带上前缀，例如 ws://192.168.1.10:8080/adh；
接入成功后 Key 会保存在 ${configFilePath()}
`.trim();

function parseCli() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      server: { type: 'string', short: 's' },
      key: { type: 'string', short: 'k' },
      // 兼容旧参数名
      code: { type: 'string', short: 'c' },
      name: { type: 'string', short: 'n' },
      'log-level': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      'skip-ios': { type: 'boolean' },
      'skip-android': { type: 'boolean' },
      force: { type: 'boolean' },
    },
  });
}

function printDoctor(report: Awaited<ReturnType<typeof runDoctor>>): void {
  console.log(`\nadh-agent doctor · ${report.platform}\n`);
  for (const check of report.checks) {
    const mark = check.ok ? '[ OK ]' : '[FAIL]';
    console.log(`${mark} ${check.name.padEnd(18)} ${check.detail}`);
    if (check.hint) console.log(`       ${''.padEnd(18)} -> ${check.hint}`);
  }
  const failed = report.checks.filter((check) => !check.ok).length;
  console.log(
    `\n${report.checks.length - failed}/${report.checks.length} 项通过${
      failed > 0 ? `，${failed} 项待处理` : ''
    }\n`,
  );
}

function startThumbnailLoop(
  client: AgentClient,
  uploader: ThumbnailUploader,
  logger: Logger,
): NodeJS.Timeout {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const targets = client
        .currentDevices()
        .filter((device) => device.platform === 'android' && device.status === 'online')
        .slice(0, 4);
      for (const device of targets) {
        const jpeg = await captureThumbnail(device.udid);
        if (!jpeg) continue;
        await uploader.upload(device.udid, jpeg);
      }
    } catch (error) {
      logger.debug({ err: String(error) }, 'thumbnail loop error');
    } finally {
      running = false;
    }
  };

  setTimeout(() => void tick(), 4_000);
  return setInterval(() => void tick(), THUMBNAIL_INTERVAL_MS);
}

async function commandConnect(values: Record<string, unknown>): Promise<void> {
  const serverUrl = values.server as string | undefined;
  if (!serverUrl) {
    console.error('缺少 --server，例如: --server ws://192.168.1.10:8080');
    process.exit(1);
  }

  const local = loadLocalConfig();
  const key =
    (values.key as string | undefined) ??
    (values.code as string | undefined) ??
    local.token;
  if (!key) {
    console.error(
      '缺少接入 Key：打开 Web 控制台 → Agent 管理 → 新建 Agent，复制生成的命令执行。',
    );
    process.exit(1);
  }

  const logger = createLogger((values['log-level'] as string | undefined) ?? 'info');

  const adbAvailable = await isAdbAvailable();
  const capabilities: AgentCapability[] = [];
  if (adbAvailable) capabilities.push('android');
  else logger.warn('未检测到 adb，Android 设备将不会被上报');

  const iosDevices = await discoverIos();
  if (iosDevices.length > 0) capabilities.push('ios');

  const name = (values.name as string | undefined) ?? local.name ?? os.hostname();

  const runtime: AgentRuntimeInfo = {
    name,
    os: process.platform === 'win32' ? 'windows' : process.platform,
    arch: process.arch,
    version: AGENT_VERSION,
    capabilities,
    protocolVersion: PROTOCOL_VERSION,
  };

  saveLocalConfig({ serverUrl, name, token: key });

  const client = new AgentClient({
    serverUrl,
    token: key,
    runtime,
    logger,
    discover: async (): Promise<DeviceInfo[]> => {
      const android = await discoverAndroid();
      const ios = await discoverIos();
      return [...android.devices, ...ios];
    },
  });

  client.start();
  const thumbnailTimer = startThumbnailLoop(
    client,
    new ThumbnailUploader(serverUrl, key, logger),
    logger,
  );

  logger.info(
    {
      name,
      capabilities,
      version: AGENT_VERSION,
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
    },
    'adh-agent started',
  );

  const shutdown = (): void => {
    logger.info('shutting down');
    clearInterval(thumbnailTimer);
    client.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  // 自动下载的工具目录优先于系统 PATH，子进程（adb / go-ios）直接生效
  ensureToolPath();

  const { values, positionals } = parseCli();
  const command = positionals[0] ?? 'help';

  if (values.version || command === 'version') {
    console.log(`adh-agent ${AGENT_VERSION} (protocol ${PROTOCOL_VERSION})`);
    return;
  }

  if (command === 'init') {
    await runInit({
      skipIos: Boolean(values['skip-ios']),
      skipAndroid: Boolean(values['skip-android']),
      force: Boolean(values.force),
    });
    return;
  }

  if (command === 'doctor') {
    printDoctor(await runDoctor());
    return;
  }

  if (command === 'connect') {
    await commandConnect(values as Record<string, unknown>);
    return;
  }

  console.log(HELP);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});