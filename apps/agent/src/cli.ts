import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
import {
  runRollback,
  runUpdate,
  runUpdateCheck,
  type UpdateOptions,
} from './update.js';

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
  adh-agent connect --server <ws://host:8080[/前缀]> [--key <接入Key>] [--name <宿主机名>] [-d]
  adh-agent start
  adh-agent stop
  adh-agent restart
  adh-agent doctor
  adh-agent update [--check] [--source <url>] [--from-file <zip>] [--force] [-y]
  adh-agent update --rollback
  adh-agent version

说明:
  init     自动下载当前系统对应的 Android Platform Tools 与 go-ios 到 ~/.adh/tools
  connect  连接 adh-server 并持续上报本机设备
           -d / --daemon  后台运行，关闭当前终端窗口也不会断开
  start    使用上次 connect 保存的配置在后台启动
  stop     停止由 -d / start 启动的后台进程
  restart  停止后再用已保存的配置重新启动
  doctor   检查 adb / go-ios / Apple 设备服务是否就绪
  update   原地更新当前安装包并自动重启（保留 vendor 与 ~/.adh 配置）
           --check        只检查版本，不下载
           --source <url> 自定义更新源（Release 目录或 manifest.json）
           --from-file    从本地 zip 更新
           --sha256 <hex> 校验本地安装包（配合 --from-file）
           --rollback     回退到上一个版本
           --no-restart   只替换文件，不自动启动
           --force        当前已是最新时也重新安装
           -y / --yes     跳过确认，适合脚本 / 计划任务

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
      daemon: { type: 'boolean', short: 'd' },
      'log-level': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      'skip-ios': { type: 'boolean' },
      'skip-android': { type: 'boolean' },
      force: { type: 'boolean' },
      check: { type: 'boolean' },
      rollback: { type: 'boolean' },
      source: { type: 'string' },
      'from-file': { type: 'string' },
      sha256: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'no-restart': { type: 'boolean' },
    },
  });
}

function updateOptions(values: Record<string, unknown>): UpdateOptions {
  return {
    check: Boolean(values.check),
    rollback: Boolean(values.rollback),
    source: values.source as string | undefined,
    fromFile: values['from-file'] as string | undefined,
    sha256: values.sha256 as string | undefined,
    force: Boolean(values.force),
    yes: Boolean(values.yes),
    noRestart: Boolean(values['no-restart']),
  };
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

/* ---------------------------- 后台运行 ---------------------------- */

const DAEMON_DIR = path.dirname(configFilePath());
const DAEMON_PID_FILE = path.join(DAEMON_DIR, 'agent.pid');
const DAEMON_LOG_FILE = path.join(DAEMON_DIR, 'agent.log');

function readDaemonPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** -d / start：重新拉起自身并脱离当前终端，关闭窗口也不会断开。 */
function startDaemon(): void {
  // 旧实例由调用方通过 ensureNoRunningInstance 处理
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  const log = fs.openSync(DAEMON_LOG_FILE, 'a');
  const childArgs = [
    ...process.execArgv,
    ...process.argv
      .slice(1)
      .filter((arg) => arg !== '-d' && !arg.startsWith('--daemon')),
  ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    // 防止子进程重复解析 -d 再拉起一层
    env: { ...process.env, ADH_DAEMON: '1' },
  });
  fs.closeSync(log);
  child.unref();

  if (child.pid) {
    fs.writeFileSync(DAEMON_PID_FILE, String(child.pid), 'utf8');
    console.log(`adh-agent 已在后台启动（PID ${child.pid}）`);
  } else {
    console.log('adh-agent 后台启动失败，请检查日志');
  }
  console.log(`日志：${DAEMON_LOG_FILE}`);
  console.log('停止：adh-agent stop');
}

function stopDaemon(): void {
  const pid = readDaemonPid();
  if (!pid) {
    console.log('没有找到后台运行的 adh-agent');
    return;
  }
  if (!processAlive(pid)) {
    fs.rmSync(DAEMON_PID_FILE, { force: true });
    console.log(`后台进程 ${pid} 已不存在，已清理 PID 文件`);
    return;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`停止失败（PID ${pid}），请手动结束该进程`);
      return;
    }
  } else {
    process.kill(pid, 'SIGTERM');
  }
  fs.rmSync(DAEMON_PID_FILE, { force: true });
  console.log(`已停止 adh-agent（PID ${pid}）`);
}

/** 退出时清理自己登记的 PID；已被新实例覆盖则保留新 PID。 */
function clearOwnPid(): void {
  if (readDaemonPid() !== process.pid) return;
  try {
    fs.rmSync(DAEMON_PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function printManageHint(): void {
  console.log('已取消启动。管理 agent 实例请使用：');
  console.log('  adh-agent start    # 后台启动');
  console.log('  adh-agent stop     # 停止');
  console.log('  adh-agent restart  # 重启（等价于覆盖旧实例）');
}

async function confirmReplace(pid: number): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      `adh-agent 已在运行（PID ${pid}）。非交互环境无法确认，已取消启动。`,
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        `adh-agent 已在运行（PID ${pid}）。是否停止旧实例并启动新的？[y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** 已有实例时询问是否覆盖；返回 true 表示可以继续启动。 */
async function ensureNoRunningInstance(): Promise<boolean> {
  const pid = readDaemonPid();
  if (!pid || pid === process.pid) return true;
  if (!processAlive(pid)) {
    fs.rmSync(DAEMON_PID_FILE, { force: true });
    return true;
  }

  if (!(await confirmReplace(pid))) {
    printManageHint();
    return false;
  }

  console.log(`正在停止旧实例（PID ${pid}）…`);
  stopDaemon();
  for (let i = 0; i < 25 && processAlive(pid); i += 1) await sleep(200);
  if (processAlive(pid)) {
    console.error(`旧实例（PID ${pid}）停止失败，请手动结束后再试`);
    return false;
  }
  console.log('旧实例已停止，继续启动新实例…');
  return true;
}

/** start：使用 connect 时保存的 server / key 连接，无需再带参数。 */
async function commandStart(values: Record<string, unknown>): Promise<void> {
  const local = loadLocalConfig();
  if (!local.serverUrl || !local.token) {
    console.error(
      '尚未保存连接配置，请先执行一次 adh-agent connect --server ... --key ...',
    );
    process.exit(1);
  }
  await commandConnect({
    server: local.serverUrl,
    key: local.token,
    name: local.name,
    'log-level': values['log-level'],
  });
}

/** restart：先停掉现有后台进程，再用保存的配置重新拉起。 */
async function restartDaemon(): Promise<void> {
  const pid = readDaemonPid();
  if (pid && processAlive(pid)) {
    stopDaemon();
    // 等进程真正退出再启动，避免端口 / 设备会话还没释放
    for (let i = 0; i < 25 && processAlive(pid); i += 1) await sleep(200);
  }
  startDaemon();
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

  // 同一台机器只允许一个实例；有旧实例时询问是否覆盖
  if (!(await ensureNoRunningInstance())) process.exit(1);
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_PID_FILE, String(process.pid), 'utf8');
  process.once('exit', clearOwnPid);

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

  let client!: AgentClient;
  let thumbnailTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');
    if (thumbnailTimer) clearInterval(thumbnailTimer);
    client.stop();
    setTimeout(() => process.exit(0), 200);
  };

  client = new AgentClient({
    serverUrl,
    token: key,
    runtime,
    logger,
    // 被服务端要求停止（key 失效 / 被新实例替换）时退出进程
    onStopped: shutdown,
    discover: async (): Promise<DeviceInfo[]> => {
      const android = androidOk
        ? await discoverAndroid()
        : { devices: [] as DeviceInfo[] };
      const ios = iosOk ? await discoverIos() : [];
      return [...android.devices, ...ios];
    },
  });

  client.start();
  thumbnailTimer = startThumbnailLoop(
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

  if (command === 'update') {
    const options = updateOptions(values as Record<string, unknown>);
    if (options.check) {
      await runUpdateCheck(options);
    } else if (options.rollback) {
      await runRollback(options);
    } else {
      await runUpdate(options);
    }
    return;
  }

  if (command === 'stop') {
    stopDaemon();
    return;
  }

  if (command === 'start' || command === 'restart') {
    if (process.env.ADH_DAEMON) {
      // 后台子进程：直接用 connect 时保存的配置连接
      await commandStart(values as Record<string, unknown>);
      return;
    }
    const local = loadLocalConfig();
    if (!local.serverUrl || !local.token) {
      console.error(
        '尚未保存连接配置，请先执行一次 adh-agent connect --server ... --key ...',
      );
      process.exit(1);
    }
    if (command === 'restart') {
      await restartDaemon();
    } else {
      if (!(await ensureNoRunningInstance())) process.exit(1);
      startDaemon();
    }
    return;
  }

  if (command === 'connect') {
    // -d：由父进程拉一起个脱离终端的后台进程后退出
    if (values.daemon && !process.env.ADH_DAEMON) {
      if (!(await ensureNoRunningInstance())) process.exit(1);
      startDaemon();
      return;
    }
    await commandConnect(values as Record<string, unknown>);
    return;
  }

  console.log(HELP);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});