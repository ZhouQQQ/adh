import os from 'node:os';
import { parseArgs } from 'node:util';
import {
  PROTOCOL_VERSION,
  type AgentCapability,
  type AgentRuntimeInfo,
  type DeviceInfo,
} from '@adh/protocol';
import { discoverAndroid, isAdbAvailable } from './android/discover.js';
import { AgentClient } from './client.js';
import { runDoctor } from './doctor.js';
import { discoverIos } from './ios/discover.js';
import { configFilePath, loadLocalConfig, saveLocalConfig } from './local-config.js';
import { createLogger } from './log.js';

const AGENT_VERSION = '0.1.0';

const HELP = `
adh-agent v${AGENT_VERSION}

用法:
  adh-agent connect --server <ws://host:8080> [--code <注册码>] [--name <宿主机名>]
  adh-agent doctor
  adh-agent version

说明:
  connect  连接 adh-server 并持续上报本机设备
  doctor   检查 adb / go-ios / Apple 设备服务是否就绪

首次接入需要使用 server 启动时打印的注册码；
接入成功后 token 会保存在 ${configFilePath()}
`.trim();

function parseCli() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      server: { type: 'string', short: 's' },
      code: { type: 'string', short: 'c' },
      name: { type: 'string', short: 'n' },
      'log-level': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function printDoctor(
  report: Awaited<ReturnType<typeof runDoctor>>,
): void {
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

async function commandConnect(values: Record<string, unknown>): Promise<void> {
  const serverUrl = values.server as string | undefined;
  if (!serverUrl) {
    console.error('缺少 --server，例如: --server ws://192.168.1.10:8080');
    process.exit(1);
  }

  const local = loadLocalConfig();
  const token = (values.code as string | undefined) ?? local.token;
  if (!token) {
    console.error(
      '缺少凭证：首次接入请使用 --code <注册码>，注册码在 adh-server 启动日志中。',
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

  const name =
    (values.name as string | undefined) ?? local.name ?? os.hostname();

  const runtime: AgentRuntimeInfo = {
    name,
    os: process.platform === 'win32' ? 'windows' : process.platform,
    arch: process.arch,
    version: AGENT_VERSION,
    capabilities,
    protocolVersion: PROTOCOL_VERSION,
  };

  saveLocalConfig({ serverUrl, name });

  const client = new AgentClient({
    serverUrl,
    token,
    runtime,
    logger,
    discover: async (): Promise<DeviceInfo[]> => {
      const android = await discoverAndroid();
      const ios = await discoverIos();
      return [...android.devices, ...ios];
    },
    onToken: (newToken) => {
      saveLocalConfig({ token: newToken });
      logger.info({ path: configFilePath() }, 'token saved');
    },
  });

  client.start();
  logger.info({ name, capabilities }, 'adh-agent started');

  const shutdown = (): void => {
    logger.info('shutting down');
    client.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const { values, positionals } = parseCli();
  const command = positionals[0] ?? 'help';

  if (values.version || command === 'version') {
    console.log(`adh-agent ${AGENT_VERSION} (protocol ${PROTOCOL_VERSION})`);
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