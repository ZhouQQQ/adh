import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  captureThumbnail,
  discoverAndroid,
  discoverIos,
  runCommand,
} from '@adh/device-host';
import {
  PROTOCOL_VERSION,
  renderBanner,
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

/** 跑一条命令确认工具可用，返回版本信息；失败返回 null。 */
async function probeCommand(
  command: string,
  args: string[] = ['version'],
): Promise<string | null> {
  const result = await runCommand(command, args, 8_000);
  if (result.failedToStart) return null;
  const raw = (result.stdout || result.stderr).trim();
  if (!raw) return '已安装';
  const first = raw.split(/\r?\n/)[0] ?? '';
  // go-ios 的 version 输出是 JSON：{"version":"1.3.2"}
  try {
    const parsed = JSON.parse(first) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version) {
      return parsed.version;
    }
  } catch {
    /* 普通文本版本号 */
  }
  return first || '已安装';
}

/** 交互式确认；非 TTY（计划任务 / systemd）时直接放行。 */
async function confirmContinue(): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('是否继续启动？[Y/n] '))
      .trim()
      .toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
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

  // 仿 Spring Boot 的启动 banner，放在环境检查之前
  console.log(
    renderBanner({
      name: 'adh-agent',
      version: AGENT_VERSION,
      details: [
        `node ${process.version}`,
        `${process.platform}/${process.arch}`,
        `server ${serverUrl}`,
      ],
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    }),
  );

  // 先把安装包内置的工具目录放到 PATH 最前面，再检查
  ensureToolPath();

  const adb = await probeCommand('adb');
  const goIos =
    (await probeCommand('ios')) ?? (await probeCommand('go-ios'));

  console.log('\n环境检查：');
  console.log(`  adb     ${adb ?? '未检测到'}`);
  console.log(`  go-ios  ${goIos ?? '未检测到'}`);

  const missing: string[] = [];
  if (!adb) missing.push('Android（adb）');
  if (!goIos) missing.push('iOS（go-ios）');

  if (missing.length > 0) {
    console.log(`\n缺少：${missing.join('、')}`);
    console.log('  安装：adh-agent init（安装包内置工具，可离线安装）');
    console.log(
      '  手动安装：adb → Android Platform Tools；go-ios → github.com/danielpaulus/go-ios/releases',
    );
    console.log('  继续启动后，对应平台的设备将无法被发现和控制。\n');

    logger.warn(
      { missing },
      '环境检查未通过，对应平台的设备将无法控制',
    );

    if (!(await confirmContinue())) {
      console.log('已取消启动。');
      process.exit(1);
    }
  }

  const androidOk = Boolean(adb);
  const iosOk = Boolean(goIos);

  const capabilities: AgentCapability[] = [];
  if (androidOk) capabilities.push('android');

  // iOS 首次发现时会自动执行 `ios tunnel start`（iOS 17+ 需要）
  if (iosOk) {
    const iosDevices = await discoverIos();
    if (iosDevices.length > 0) capabilities.push('ios');
  }

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
      const android = androidOk
        ? await discoverAndroid()
        : { devices: [] as DeviceInfo[] };
      const ios = iosOk ? await discoverIos() : [];
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