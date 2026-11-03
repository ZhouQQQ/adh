import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  BUILTIN_AGENT_ID,
  UpdateAgentBodySchema,
  type AgentSummary,
  type DeviceSummary,
  type SafeKeyboardLayout,
} from '@adh/protocol';
import { runCommand, runCommandBuffer, resolveQuality } from '@adh/device-host';
import { SERVER_VERSION } from '../config.js';
import type { CommandBus } from '../command-bus.js';
import type { Queries } from '../db/queries.js';
import type { DeviceLogService } from '../logs/device-logs.js';
import { baseName, normalizeDevicePath, parseLsOutput } from '../files/ls.js';
import type { AgentRegistry } from '../registry.js';
import { PackageStore, packageKind, type PackageKind } from '../storage/packages.js';
import type { OssStore } from '../storage/oss.js';
import type { SettingsService } from '../settings/service.js';
import { isAdminRole } from '../auth/service.js';
import { AppIconStore } from '../storage/app-icons.js';
import type { ThumbnailStore } from '../storage/thumbnails.js';
import type { StreamManager } from '../stream/manager.js';
import type { WebHub } from '../ws/web-hub.js';
import AppInfoParser from 'app-info-parser';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import {
  wdaAppSwitcher,
  wdaApplyMjpegSettings,
  wdaLock,
  wdaPinch,
  wdaPressButton,
  wdaScreenshot,
  wdaStatus,
  wdaSwipe,
  wdaTap,
  wdaTypeText,
  wdaUnlock,
  wdaWindow,
} from '../ios/wda.js';
import { ensureMjpegPort } from '../ios/mjpeg.js';

export interface HttpDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  thumbnails: ThumbnailStore;
  packages: PackageStore;
  icons: AppIconStore;
  oss: OssStore | null;
  agentDistDir: string;
  commands: CommandBus;
  streams: StreamManager;
  deviceLogs: DeviceLogService;
  settings: SettingsService;
  port: number;
}

const CreateAgentBody = z.object({
  name: z.string().trim().min(1).max(40),
});

const InstallBody = z.object({
  packageId: z.string().regex(/^[a-f0-9]{64}$/),
});

const UpdatePackageBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  remark: z.string().max(200).nullable().optional(),
  tags: z
    .array(z.string().trim().min(1).max(32))
    .max(20)
    .optional(),
});

const IosInputBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tap'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('swipe'),
    fromX: z.number().min(0).max(1),
    fromY: z.number().min(0).max(1),
    toX: z.number().min(0).max(1),
    toY: z.number().min(0).max(1),
    duration: z.number().min(0).max(5).optional(),
  }),
  /** 双指缩放：scale > 1 放大，< 1 缩小。 */
  z.object({
    type: z.literal('pinch'),
    scale: z.number().min(0.1).max(10),
    duration: z.number().min(0.1).max(2).optional(),
  }),
  z.object({
    type: z.literal('button'),
    name: z.enum(['home', 'volumeUp', 'volumeDown']),
  }),
  z.object({ type: z.literal('appSwitcher') }),
  /** 锁屏 / 唤醒：模拟电源键。 */
  z.object({ type: z.literal('screen'), on: z.boolean() }),
  z.object({ type: z.literal('screenToggle') }),
  /** 静音：把音量连续降到 0。 */
  z.object({ type: z.literal('mute') }),
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(2000),
  }),
]);

const FilePathsBody = z.object({
  paths: z.array(z.string().min(1)).min(1).max(200),
});

const FilePasteBody = z.object({
  paths: z.array(z.string().min(1)).min(1).max(200),
  targetDir: z.string().min(1),
  mode: z.enum(['copy', 'move']),
});

const FileRenameBody = z.object({
  path: z.string().min(1),
  newName: z.string().min(1).max(200),
});

const SafeKeyboardBody = z.object({
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  height: z.number().min(10).max(100),
  opacity: z.number().min(0.05).max(1),
});

const UpdateDeviceBody = z.object({
  publishedAt: z.number().int().min(0).optional(),
  safeKeyboard: SafeKeyboardBody.nullable().optional(),
  /** 仅管理员可用：锁定后普通用户不能控制也不能查看。 */
  locked: z.boolean().optional(),
});

/** 这些目录不允许被删除或移动。 */
const PROTECTED_PATHS = new Set([
  '/',
  '/sdcard',
  '/storage',
  '/storage/emulated',
  '/storage/emulated/0',
]);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface PackageMeta {
  version: string | null;
  installedAt: string | null;
  updatedAt: string | null;
}

/** 从 dumpsys package 输出里提取 versionName / 安装时间 / 更新时间。 */
function parsePackageMeta(raw: string): Map<string, PackageMeta> {
  const meta = new Map<string, PackageMeta>();
  let current: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*Package \[([^\]]+)\]/.exec(line);
    if (header) {
      current = header[1] ?? null;
      if (current && !meta.has(current)) {
        meta.set(current, { version: null, installedAt: null, updatedAt: null });
      }
      continue;
    }
    if (!current) continue;

    const entry = meta.get(current);
    if (!entry) continue;

    const version = /^\s+versionName=(\S+)/.exec(line);
    if (version && !entry.version) entry.version = version[1] ?? null;

    const installed = /^\s+firstInstallTime=(.+)$/.exec(line);
    if (installed && !entry.installedAt) entry.installedAt = installed[1]?.trim() ?? null;

    const updated = /^\s+lastUpdateTime=(.+)$/.exec(line);
    if (updated && !entry.updatedAt) entry.updatedAt = updated[1]?.trim() ?? null;
  }
  return meta;
}

/** 从 `pm list packages -f` + stat 的结果里取每个包 APK 大小。 */
function parseAppSizes(raw: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.]+)\|(\d+)$/.exec(line.trim());
    if (!match) continue;
    sizes.set(match[1]!, Number(match[2]));
  }
  return sizes;
}

/** 从 dumpsys usagestats 的事件流里取每个包最后一次启动时间。 */
function parseLastUsed(raw: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s+time="([^"]+)"\s+type=ACTIVITY_RESUMED\s+package=(\S+)/.exec(line);
    if (!match) continue;
    // 事件按时间顺序输出，后面覆盖前面即为最后一次
    times.set(match[2]!, match[1]!);
  }
  return times;
}

/** 图标解析任务最多并行 2 个，避免同时拉多个大 APK 把 adb 占满。 */
const MAX_ICON_JOBS = 2;
let runningIcons = 0;
const waitingIcons: Array<() => void> = [];

async function enqueueIcon<T>(task: () => Promise<T>): Promise<T> {
  if (runningIcons >= MAX_ICON_JOBS) {
    await new Promise<void>((resolve) => waitingIcons.push(resolve));
  }
  runningIcons += 1;
  try {
    return await task();
  } finally {
    runningIcons -= 1;
    waitingIcons.shift()?.();
  }
}

/** adb pull 出 APK，解析图标并统一压成 96px PNG。 */
async function fetchAppIcon(udid: string, packageName: string): Promise<Buffer | null> {
  const pathResult = await runCommand(
    'adb',
    ['-s', udid, 'shell', 'pm', 'path', packageName],
    15_000,
  );
  if (pathResult.code !== 0) return null;

  const paths = pathResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length));

  const remote = paths.find((item) => item.endsWith('base.apk')) ?? paths[0];
  if (!remote) return null;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-icon-'));
  const local = path.join(tempDir, 'base.apk');

  try {
    const pull = await runCommand('adb', ['-s', udid, 'pull', remote, local], 120_000);
    if (pull.code !== 0) return null;

    const parser = new AppInfoParser(local);
    const info = await parser.parse();
    const raw = info.icon ?? info.application?.icon;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const encoded = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0) return null;

    return await sharp(bytes)
      .resize(96, 96, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

interface RuntimeStats {
  battery: {
    level: number | null;
    charging: boolean;
    status: string;
    /** 电池温度（摄氏度），设备不提供时为 null。 */
    temperature: number | null;
  };
  memory: { totalMb: number; usedMb: number | null } | null;
  storage: { totalMb: number; usedMb: number } | null;
  wifi: { connected: boolean; ssid: string | null; enabled: boolean; ip?: string | null } | null;
  /** 已开机秒数，拿不到时为 null。 */
  uptimeSeconds: number | null;
}

/** iOS 屏幕亮灭状态，用于电源键切换。 */
const iosScreenUnlocked = new Map<string, boolean>();

/** go-ios 的命令名兼容 ios / go-ios。 */
let iosCliCache: { at: number; command: string | null } | null = null;

async function runIos(args: string[], timeout = 15_000) {
  if (!iosCliCache || Date.now() - iosCliCache.at > 60_000) {
    let command: string | null = null;
    for (const candidate of ['ios', 'go-ios']) {
      const probe = await runCommand(candidate, ['version'], 5_000);
      if (!probe.failedToStart) {
        command = candidate;
        break;
      }
    }
    iosCliCache = { at: Date.now(), command };
  }
  if (!iosCliCache.command) return null;
  return runCommand(iosCliCache.command, args, timeout);
}

function parseJsonLoose<T>(raw: string): T | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

interface IosBatteryInfo {
  BatteryCurrentCapacity?: number;
  BatteryIsCharging?: boolean;
  ExternalConnected?: boolean;
}

function parseIosBattery(raw: string): RuntimeStats['battery'] | null {
  const info = parseJsonLoose<IosBatteryInfo>(raw);
  if (!info) return null;
  const charging = Boolean(info.BatteryIsCharging || info.ExternalConnected);
  return {
    level: typeof info.BatteryCurrentCapacity === 'number' ? info.BatteryCurrentCapacity : null,
    charging,
    status: charging ? 'charging' : 'discharging',
    // iOS 的 batterycheck 不提供温度
    temperature: null,
  };
}

interface IosDiskInfo {
  TotalBytes?: number;
  FreeBytes?: number;
}

function parseIosStorage(raw: string): RuntimeStats['storage'] {
  const info = parseJsonLoose<IosDiskInfo>(raw);
  const total = Number(info?.TotalBytes ?? 0);
  const free = Number(info?.FreeBytes ?? 0);
  if (!total || total <= 0) return null;
  return {
    totalMb: Math.round(total / 1024 / 1024),
    usedMb: Math.round(Math.max(0, total - free) / 1024 / 1024),
  };
}

function parseBattery(raw: string): RuntimeStats['battery'] {
  const level = Number(/^\s*level:\s*(\d+)/m.exec(raw)?.[1] ?? NaN);
  const status = Number(/^\s*status:\s*(\d+)/m.exec(raw)?.[1] ?? NaN);
  // dumpsys 的温度单位是 0.1℃，300 表示 30.0℃
  const temperatureRaw = Number(
    /^\s*temperature:\s*(-?\d+)/m.exec(raw)?.[1] ?? NaN,
  );
  const powered =
    /AC powered: true/.test(raw) ||
    /USB powered: true/.test(raw) ||
    /Wireless powered: true/.test(raw);

  return {
    level: Number.isFinite(level) ? level : null,
    charging: status === 2 || status === 5 || powered,
    status:
      status === 5
        ? 'full'
        : status === 2
          ? 'charging'
          : status === 4
            ? 'not-charging'
            : status === 3
              ? 'discharging'
              : 'unknown',
    temperature: Number.isFinite(temperatureRaw)
      ? Math.round(Math.abs(temperatureRaw)) / 10
      : null,
  };
}

function parseMemory(raw: string): RuntimeStats['memory'] {
  const totalKb = Number(/MemTotal:\s+(\d+) kB/.exec(raw)?.[1] ?? NaN);
  const availableKb = Number(/MemAvailable:\s+(\d+) kB/.exec(raw)?.[1] ?? NaN);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) return null;
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb: Math.round((totalKb - availableKb) / 1024),
  };
}

function parseUptime(raw: string): number | null {
  const seconds = Number(raw.trim().split(/\s+/)[0]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}

function parseStorage(raw: string): RuntimeStats['storage'] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Filesystem'));

  // 部分机型 /data 被 bind mount，df 的挂载点不是 /data（例如红米 K30 Pro
  // 会输出 /apex/.../dex2oat64），此时退回第一行数据，`df -k /data` 只会返回目标文件系统的行。
  const line = lines.find((item) => /\s\/data\S*$/.test(item)) ?? lines[0];
  if (!line) return null;

  const parts = line.split(/\s+/);
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) return null;
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb: Math.round(usedKb / 1024),
  };
}

function parseWifi(raw: string): RuntimeStats['wifi'] {
  const connected = /Wifi is connected to "([^"]+)"/.exec(raw);
  if (connected) {
    return { connected: true, ssid: connected[1] ?? null, enabled: true };
  }
  return {
    connected: false,
    ssid: null,
    enabled: /Wifi is enabled/.test(raw),
  };
}

/** 从 `ip -f inet addr show wlan0` 里取 IPv4。 */
function parseWifiIp(raw: string): string | null {
  const match = /inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(raw);
  return match?.[1] ?? null;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function withOnline(
  summary: AgentSummary,
  registry: AgentRegistry,
): AgentSummary {
  // 内置 Agent 的生命周期与 server 进程一致
  if (summary.builtin) return { ...summary, online: true };
  return { ...summary, online: registry.isOnline(summary.id) };
}

export async function registerHttpRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  const logDevice = (
    request: FastifyRequest,
    device: { id: string; name: string },
    action: string,
    detail?: string,
  ): void => {
    void deps.deviceLogs.write({
      deviceId: device.id,
      deviceName: device.name,
      userId: request.user?.id,
      username: request.user?.username,
      action,
      detail,
      ip: request.ip,
    });
  };

  app.addContentTypeParser(
    'image/jpeg',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.addContentTypeParser(
    'application/vnd.android.package-archive',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/api/health', async () => ({
    ok: true,
    version: SERVER_VERSION,
    uptime: Math.round(process.uptime()),
    onlineAgents: deps.registry.ids().length,
  }));

  app.get('/api/server-info', async () => ({
    version: SERVER_VERSION,
    port: deps.port,
    storage: deps.oss
      ? { driver: 'oss' as const, bucket: deps.oss.bucket, prefix: deps.oss.prefix }
      : { driver: 'local' as const },
  }));

  /* ---------------------------------------------------------------- */
  /* Agent 安装包                                                      */
  /* ---------------------------------------------------------------- */

  const AGENT_PLATFORMS = ['win32', 'darwin'] as const;

  /** 每个平台取最新的一份 zip，兼容 adh-agent-win32.zip 与 adh-agent-win32-x64.zip。 */
  const listAgentPackages = (): {
    platform: string;
    file: string;
    size: number;
    updatedAt: number;
  }[] => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(deps.agentDistDir);
    } catch {
      return [];
    }

    const result = [];
    for (const platform of AGENT_PLATFORMS) {
      const pattern = new RegExp(`^adh-agent-${platform}(-[a-z0-9_]+)?\\.zip$`, 'i');
      let newest: { file: string; size: number; updatedAt: number } | null = null;
      for (const entry of entries) {
        if (!pattern.test(entry)) continue;
        const stat = fs.statSync(path.join(deps.agentDistDir, entry));
        // 跳过中断打包留下的 0 字节文件
        if (stat.size < 1024) continue;
        if (!newest || stat.mtimeMs > newest.updatedAt) {
          newest = { file: entry, size: stat.size, updatedAt: stat.mtimeMs };
        }
      }
      if (newest) result.push({ platform, ...newest });
    }
    return result;
  };

  app.get('/api/agent/platforms', async () => ({
    platforms: listAgentPackages(),
  }));

  /** 按平台下载 `pnpm package:agent` 生成的离线包；不传平台时用服务器当前平台。 */
  app.get('/api/agent/download', async (request, reply) => {
    const { platform } = request.query as { platform?: string };
    const packages = listAgentPackages();
    const target =
      packages.find((item) => item.platform === platform) ??
      packages.find((item) => item.platform === process.platform) ??
      packages[0];

    if (!target) {
      return reply.code(404).send({
        error: '还没有生成 Agent 安装包，请在服务器执行 pnpm package:agent',
      });
    }

    const data = fs.readFileSync(path.join(deps.agentDistDir, target.file));
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${target.file}"`)
      .send(data);
  });

  /* ---------------------------------------------------------------- */
  /* Agent 管理                                                        */
  /* ---------------------------------------------------------------- */

  app.get('/api/agents', async () => {
    const agents = await deps.queries.listAgents();
    return agents.map((agent) => withOnline(agent, deps.registry));
  });

  /** 详情：返回完整 Key，便于随时查看接入命令。 */
  app.get('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await deps.queries.getAgent(id);
    const summary = await deps.queries.getAgentSummary(id);
    if (!row || !summary) {
      return reply.code(404).send({ error: 'agent not found' });
    }
    return { agent: withOnline(summary, deps.registry), key: row.token };
  });

  app.patch('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === BUILTIN_AGENT_ID) {
      return reply
        .code(400)
        .send({ error: '内置 Agent 的名称跟随宿主机，无法修改' });
    }

    const parsed = UpdateAgentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '名称长度需在 1-40 个字符之间' });
    }

    const existing = await deps.queries.getAgent(id);
    if (!existing) return reply.code(404).send({ error: 'agent not found' });

    const name = parsed.data.name;
    const conflict = await deps.queries.findAgentByName(name);
    if (conflict && conflict.id !== id) {
      return reply.code(409).send({ error: '同名 Agent 已存在' });
    }

    const row = await deps.queries.renameAgent(id, name);
    if (!row) return reply.code(404).send({ error: 'agent not found' });

    const summary = await deps.queries.getAgentSummary(id);
    if (!summary) return reply.code(500).send({ error: 'agent not found' });
    const agent = withOnline(summary, deps.registry);
    deps.hub.broadcast({ t: 'agent.updated', agent });
    return { agent };
  });

  app.post('/api/agents', async (request, reply) => {
    const parsed = CreateAgentBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'name is required' });
    }
    const existing = await deps.queries.findAgentByName(parsed.data.name);
    if (existing) {
      return reply.code(409).send({ error: '同名 Agent 已存在' });
    }

    const row = await deps.queries.createAgent(parsed.data.name);
    const summary = await deps.queries.getAgentSummary(row.id);
    if (!summary) return reply.code(500).send({ error: 'failed to create agent' });

    const agent = withOnline(summary, deps.registry);
    deps.hub.broadcast({ t: 'agent.updated', agent });
    return reply.code(201).send({ agent, key: row.token });
  });

  app.post('/api/agents/:id/rotate', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === BUILTIN_AGENT_ID) {
      return reply.code(400).send({ error: '内置 Agent 由 server 自动管理，无法重置 Key' });
    }
    const row = await deps.queries.rotateAgentToken(id);
    if (!row) return reply.code(404).send({ error: 'agent not found' });

    const summary = await deps.queries.getAgentSummary(id);
    if (!summary) return reply.code(500).send({ error: 'agent not found' });
    const agent = withOnline(summary, deps.registry);
    deps.hub.broadcast({ t: 'agent.updated', agent });
    return { agent, key: row.token };
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === BUILTIN_AGENT_ID) {
      return reply.code(400).send({ error: '内置 Agent 由 server 自动管理，无法删除' });
    }
    const agentDevices = await deps.queries.listDevices(id);
    if (!(await deps.queries.deleteAgent(id))) {
      return reply.code(404).send({ error: 'agent not found' });
    }
    for (const device of agentDevices) {
      deps.thumbnails.remove(device.id);
      deps.hub.broadcast({ t: 'device.removed', deviceId: device.id });
    }
    deps.hub.broadcast({ t: 'agent.removed', agentId: id });
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* 设备                                                              */
  /* ---------------------------------------------------------------- */

  app.get('/api/devices', async () => {
    const online = new Set(deps.registry.ids());
    const isOnline = (agentId: string): boolean =>
      agentId === BUILTIN_AGENT_ID || online.has(agentId);
    const inUse = new Set(deps.streams.listInUseDeviceIds());
    const devices: DeviceSummary[] = await deps.queries.listDevices();
    return devices.map((device) => ({
      ...(isOnline(device.agentId) ? device : { ...device, status: 'offline' as const }),
      inUse: inUse.has(device.id),
      control: deps.streams.getControl(device.id),
    }));
  });

  app.get('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    return { ...device, inUse: deps.streams.isInUse(id), control: deps.streams.getControl(id) };
  });

  /** 编辑设备元信息（发布时间、安全键盘、管理员锁定）。 */
  app.patch('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateDeviceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }
    if (
      parsed.data.locked !== undefined &&
      !isAdminRole(request.user?.role ?? '')
    ) {
      return reply.code(403).send({ error: '只有管理员可以锁定设备' });
    }

    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });

    const patch = { ...parsed.data } as {
      publishedAt?: number;
      safeKeyboard?: SafeKeyboardLayout | null;
      locked?: boolean;
      lockedBy?: string | null;
      lockedAt?: number;
    };
    if (parsed.data.locked !== undefined) {
      patch.lockedBy = parsed.data.locked
        ? (request.user?.username ?? null)
        : null;
      patch.lockedAt = parsed.data.locked ? Date.now() : 0;
    }

    const updated = await deps.queries.updateDeviceMeta(id, patch);
    if (!updated) return reply.code(404).send({ error: '设备不存在' });

    // 锁定时立刻断开所有正在控制 / 观看的人，解锁后才能重新进入
    if (parsed.data.locked !== undefined) {
      deps.streams.setLocked(id, parsed.data.locked);
      if (parsed.data.locked) {
        logDevice(request, device, 'device.lock', '锁定设备，任何人不能控制或查看');
      } else {
        logDevice(request, device, 'device.unlock', '解除设备锁定');
      }
    }

    const summary = { ...updated, inUse: deps.streams.isInUse(id) };
    deps.hub.broadcast({ t: 'device.updated', device: summary });
    return summary;
  });

  /** 手动上传设备图片，覆盖自动截图。 */
  app.post('/api/devices/:id/thumbnail', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: '图片内容为空' });
    }
    if (body.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ error: '图片超过 5MB' });
    }

    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });

    deps.thumbnails.save(id, body);
    const updated = await deps.queries.setManualThumbnail(id);
    if (!updated) return reply.code(500).send({ error: '保存失败' });

    const summary = { ...updated, inUse: deps.streams.isInUse(id) };
    deps.hub.broadcast({ t: 'device.updated', device: summary });
    return summary;
  });

  /** 创建投屏会话，返回 sessionId 供浏览器连接 /ws/stream/:id。 */
  app.post('/api/devices/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    // 锁定后只有管理员能进入，其他人既不能控制也不能查看
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }
    // 同时控制设备数按角色限制，0 表示不限
    if (request.user) {
      const limit = await deps.settings.getDeviceLimit(request.user.role);
      const current = deps.streams.getControl(id);
      const alreadyMine = current?.userId === request.user.id;
      // 只读观看不占名额，只有会拿到控制权时才校验
      const willControl = deps.streams.willBecomeController(
        id,
        request.user.id,
      );
      if (
        limit > 0 &&
        willControl &&
        !alreadyMine &&
        deps.streams.countControlledDevices(request.user.id) >= limit
      ) {
        return reply.code(403).send({
          error: `最多同时控制 ${limit} 台设备，只读查看不受限制`,
        });
      }
    }
    const body = request.body as { quality?: string } | undefined;
    try {
      return await deps.streams.create(id, body?.quality ?? 'medium');
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : '无法创建投屏会话',
      });
    }
  });

  /** 切换画质：重建会话。 */
  app.post('/api/devices/:id/stream/restart', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }
    const body = request.body as { quality?: string } | undefined;
    try {
      const result = await deps.streams.restart(
        id,
        body?.quality ?? 'medium',
      );
      const label =
        body?.quality === 'low'
          ? '低画质'
          : body?.quality === 'high'
            ? '高画质'
            : '中画质';
      logDevice(request, device, 'control.quality', `切换为${label}`);
      return result;
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : '无法切换画质',
      });
    }
  });

  /** 管理员强制断开某台设备当前的投屏。 */
  app.post('/api/devices/:id/stream/kick', async (request, reply) => {
    if (!isAdminRole(request.user?.role ?? '')) {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });

    const kicked = deps.streams.kickDevice(id);
    if (kicked) {
      logDevice(request, device, 'control.kick', '强制断开他人投屏');
    }
    return { ok: kicked };
  });

  /** 接管他人正在控制的设备；控制权空出来时任何人都能接管。 */
  app.post('/api/devices/:id/stream/takeover', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (!request.user) return reply.code(401).send({ error: '请先登录' });
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }

    const ok = deps.streams.takeover(id, request.user);
    if (!ok) {
      return reply.code(400).send({ error: '控制权已被占用或会话不存在' });
    }
    logDevice(
      request,
      device,
      'control.takeover',
      request.user.role === 'admin' || request.user.role === 'superadmin'
        ? '管理员接管控制权'
        : '接管控制权',
    );
    return { ok: true };
  });

  /** 控制者开关「允许其他人查看」。 */
  app.post('/api/devices/:id/stream/viewers', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (!request.user) return reply.code(401).send({ error: '请先登录' });

    const body = request.body as { allow?: boolean } | undefined;
    if (typeof body?.allow !== 'boolean') {
      return reply.code(400).send({ error: '缺少 allow 参数' });
    }

    const ok = deps.streams.setAllowViewers(id, request.user, body.allow);
    if (!ok) {
      return reply.code(403).send({ error: '只有控制者或管理员可以修改' });
    }
    logDevice(
      request,
      device,
      'control.viewers',
      body.allow ? '允许他人查看' : '关闭他人查看',
    );
    return { ok: true };
  });

  /** 控制者主动释放控制权；管理员也可以断开任意会话。 */
  app.post('/api/devices/:id/stream/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (!request.user) return reply.code(401).send({ error: '请先登录' });

    const ok = deps.streams.releaseControl(id, request.user);
    if (!ok) {
      return reply.code(403).send({ error: '只有控制者或管理员可以断开' });
    }
    logDevice(request, device, 'control.stop', '释放控制权');
    return { ok: true };
  });

  /** iOS 申请控制权：同一时间只有一个人能控制，其他人只读。 */
  app.post('/api/devices/:id/ios/control', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (device.platform !== 'ios') {
      return reply.code(400).send({ error: '仅支持 iOS 设备' });
    }
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }
    if (!request.user) return reply.code(401).send({ error: '请先登录' });

    const current = deps.streams.getControl(id);
    const alreadyMine = current?.userId === request.user.id;
    if (!alreadyMine) {
      const limit = await deps.settings.getDeviceLimit(request.user.role);
      if (
        limit > 0 &&
        deps.streams.countControlledDevices(request.user.id) >= limit
      ) {
        return reply.code(403).send({
          error: `最多同时控制 ${limit} 台设备，只读查看不受限制`,
        });
      }
    }

    const result = deps.streams.claimIosControl(id, request.user);
    if (!result.granted) {
      return { granted: false, control: result.control };
    }
    if (!alreadyMine) {
      logDevice(request, device, 'control.start', '开始控制（iOS）');
    }
    return { granted: true, control: result.control };
  });

  /** iOS 控制权心跳：前端每 30 秒调用一次，超时自动释放。 */
  app.post(
    '/api/devices/:id/ios/control/heartbeat',
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: '请先登录' });
      const { id } = request.params as { id: string };
      return { ok: deps.streams.touchIosControl(id, request.user.id) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* APK 安装                                                          */
  /* ---------------------------------------------------------------- */

  /** 上传安装包（apk / ipa），按 sha256 去重存储。 */
  app.post('/api/packages', async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: '安装包内容为空' });
    }
    if (body.length > 512 * 1024 * 1024) {
      return reply.code(413).send({ error: '安装包超过 512MB' });
    }

    const rawName = request.headers['x-file-name'];
    const name =
      typeof rawName === 'string' && rawName
        ? decodeURIComponent(rawName)
        : `${PackageStore.hash(body).slice(0, 8)}.apk`;

    if (!/\.(apk|ipa)$/i.test(name)) {
      return reply.code(400).send({ error: '只支持 .apk 或 .ipa 文件' });
    }

    const id = PackageStore.hash(body);
    const record = await deps.packages.save(id, body, name);
    // 后台解析图标，第一次打开列表就有图
    void ensurePackageIcon(record.id);
    return {
      id: record.id,
      name: record.name,
      size: record.size,
      kind: record.kind,
    };
  });

  /** 已上传的安装包列表。 */
  app.get('/api/packages', async () => {
    return { packages: await deps.packages.list() };
  });

  /** 安装包图标：首次访问时从 apk / ipa 里解析出来并缓存。 */
  const packageIconKey = (id: string): string => `pkg-${id.slice(0, 16)}`;

  async function ensurePackageIcon(id: string): Promise<Buffer | null> {
    const key = packageIconKey(id);
    if (deps.icons.has(key)) return deps.icons.read(key);
    if (!(await deps.packages.ensureLocal(id))) return null;

    const file = await deps.packages.path(id);
    try {
      const parser = new AppInfoParser(file);
      const info = await parser.parse();
      const raw = info.icon ?? info.application?.icon;
      if (typeof raw !== 'string' || raw.length === 0) return null;

      const encoded = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length === 0) return null;

      const png = await sharp(bytes)
        .resize(96, 96, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      deps.icons.save(key, png);
      return png;
    } catch {
      return null;
    }
  }

  app.get('/api/packages/:id/icon', async (request, reply) => {
    const { id } = request.params as { id: string };
    const png = await ensurePackageIcon(id);
    if (!png) return reply.code(404).send({ error: '暂无图标' });
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=86400')
      .send(png);
  });

  /** 编辑安装包：重命名、备注、标签。 */
  app.patch('/api/packages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdatePackageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }
    if (
      parsed.data.name === undefined &&
      parsed.data.remark === undefined &&
      parsed.data.tags === undefined
    ) {
      return reply.code(400).send({ error: '没有需要修改的内容' });
    }

    const record = await deps.packages.record(id);
    if (!record) {
      return reply.code(404).send({ error: '安装包不存在' });
    }

    if (parsed.data.name !== undefined) {
      const name = parsed.data.name.trim();
      if (packageKind(name) !== record.kind) {
        return reply.code(400).send({
          error: `文件后缀必须是 .${record.kind}`,
        });
      }
    }

    const next = await deps.packages.updateMeta(id, {
      name: parsed.data.name?.trim(),
      remark: parsed.data.remark,
      tags: parsed.data.tags?.map((tag) => tag.trim()).filter(Boolean),
    });
    if (!next) return reply.code(404).send({ error: '安装包不存在' });
    return { package: next };
  });

  /** 删除已上传的安装包。 */
  app.delete('/api/packages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await deps.packages.record(id))) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    await deps.packages.remove(id);
    return reply.code(204).send();
  });

  const packageContentType = (kind: PackageKind): string =>
    kind === 'ipa'
      ? 'application/octet-stream'
      : 'application/vnd.android.package-archive';

  /** 前端导出安装包（无需 agent 鉴权）。 */
  app.get('/api/packages/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await deps.packages.record(id);
    if (!record || !(await deps.packages.ensureLocal(id))) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    const data = await deps.packages.read(id);
    if (!data) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    return reply
      .header('content-type', packageContentType(record.kind))
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
      )
      .send(data);
  });

  /** agent 下载安装包（用自身 Key 鉴权）。 */
  app.get('/api/packages/:id/download', async (request, reply) => {
    const token = bearerToken(request);
    const agent = token ? await deps.queries.findAgentByToken(token) : null;
    if (!agent) return reply.code(401).send({ error: 'invalid agent key' });

    const { id } = request.params as { id: string };
    const record = await deps.packages.record(id);
    if (!record || !(await deps.packages.ensureLocal(id))) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    const data = await deps.packages.read(id);
    if (!data) return reply.code(404).send({ error: '安装包不存在' });

    return reply
      .header('content-type', packageContentType(record.kind))
      .header('content-length', String(data.length))
      .send(data);
  });

  /** 把安装包推给设备并执行 adb install。 */
  app.post('/api/devices/:id/install', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = InstallBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '缺少有效的 packageId' });
    }

    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });

    const record = await deps.packages.record(parsed.data.packageId);
    if (!record) {
      return reply.code(404).send({ error: '安装包不存在，请重新上传' });
    }

    if (device.platform === 'ios') {
      if (device.agentId !== BUILTIN_AGENT_ID) {
        return reply.code(400).send({ error: 'iOS 安装仅支持 server 本机节点' });
      }
      if (record.kind !== 'ipa') {
        return reply.code(400).send({ error: 'iOS 只能安装 IPA' });
      }
      if (!(await deps.packages.ensureLocal(parsed.data.packageId))) {
        return reply.code(404).send({ error: '安装包文件缺失，请重新上传' });
      }

      const result = await runIos(
        [
          'install',
          `--path=${await deps.packages.path(parsed.data.packageId)}`,
          `--udid=${device.udid}`,
        ],
        300_000,
      );
      const output = result
        ? `${result.stdout}\n${result.stderr}`.trim()
        : '';
      if (!result || result.code !== 0) {
        return reply.code(400).send({ error: output || 'IPA 安装失败' });
      }
      logDevice(request, device, 'app.install', record.name);
      return { ok: true };
    }

    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '目前只支持安装 APK / IPA' });
    }
    if (record.kind === 'ipa') {
      return reply.code(400).send({ error: 'Android 设备只能安装 APK' });
    }
    if (!(await deps.packages.ensureLocal(parsed.data.packageId))) {
      return reply.code(404).send({ error: '安装包文件缺失，请重新上传' });
    }

    if (device.agentId === BUILTIN_AGENT_ID) {
      const result = await runCommand(
        'adb',
        [
          '-s',
          device.udid,
          'install',
          '-r',
          '-d',
          await deps.packages.path(parsed.data.packageId),
        ],
        300_000,
      );
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.code !== 0 || !/success/i.test(result.stdout)) {
        const hint = /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(output)
          ? '签名与已安装版本不一致，请先卸载旧版本再安装'
          : output || '安装失败';
        return reply.code(400).send({ error: hint });
      }
      logDevice(request, device, 'app.install', record.name);
      return { ok: true };
    }

    const host = request.headers.host ?? `127.0.0.1:${deps.port}`;
    const url = `http://${host}/api/packages/${parsed.data.packageId}/download`;

    try {
      const result = await deps.commands.send(
        device.agentId,
        'app.install',
        { udid: device.udid, url },
        device.id,
        300_000,
      );
      if (!result.ok) {
        return reply.code(400).send({ error: result.error ?? '安装失败' });
      }
      logDevice(request, device, 'app.install', record.name);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : '下发安装指令失败',
      });
    }
  });

  /* ---------------------------------------------------------------- */
  /* 设备文件管理                                                       */
  /* ---------------------------------------------------------------- */

  const requireLocalDevice = async (
    deviceId: string,
    reply: FastifyReply,
  ): Promise<DeviceSummary | null> => {
    const device = await deps.queries.getDevice(deviceId);
    if (!device) {
      void reply.code(404).send({ error: '设备不存在' });
      return null;
    }
    if (device.agentId !== BUILTIN_AGENT_ID) {
      void reply
        .code(400)
        .send({ error: '文件管理目前只支持本机接入的设备' });
      return null;
    }
    return device;
  };

  /** iOS 输入只允许当前控制者调用，只读用户不能操作。 */
  const requireIosController = (
    deviceId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): boolean => {
    if (!request.user) {
      void reply.code(401).send({ error: '请先登录' });
      return false;
    }
    const control = deps.streams.getControl(deviceId);
    if (!control || control.userId !== request.user.id) {
      void reply
        .code(403)
        .send({ error: '当前设备由其他人控制，你只能查看' });
      return false;
    }
    return true;
  };

  app.get('/api/devices/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const { path: rawPath } = request.query as { path?: string };
    const dir = normalizeDevicePath(rawPath ?? '/storage/emulated/0');
    const result = await runCommand(
      'adb',
      ['-s', device.udid, 'shell', 'ls', '-la', dir],
      20_000,
    );
    if (result.code !== 0) {
      return reply
        .code(400)
        .send({ error: result.stderr.trim() || '读取目录失败' });
    }
    return { path: dir, entries: parseLsOutput(result.stdout) };
  });

  app.get('/api/devices/:id/files/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const { path: rawPath } = request.query as { path?: string };
    if (!rawPath) return reply.code(400).send({ error: '缺少文件路径' });
    const filePath = normalizeDevicePath(rawPath);

    const result = await runCommandBuffer(
      'adb',
      ['-s', device.udid, 'exec-out', 'cat', filePath],
      120_000,
    );
    if (result.code !== 0 || result.stdout.length === 0) {
      return reply
        .code(400)
        .send({ error: result.stderr.trim() || '读取文件失败' });
    }

    const name = baseName(filePath);
    logDevice(request, device, 'file.download', filePath);
    return reply
      .header('content-type', 'application/octet-stream')
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(result.stdout);
  });

  app.post('/api/devices/:id/files/upload', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: '文件内容为空' });
    }
    if (body.length > 512 * 1024 * 1024) {
      return reply.code(413).send({ error: '文件超过 512MB' });
    }

    const { dir: rawDir } = request.query as { dir?: string };
    const dir = normalizeDevicePath(rawDir ?? '/storage/emulated/0');

    const rawName = request.headers['x-file-name'];
    const name =
      typeof rawName === 'string' && rawName
        ? decodeURIComponent(rawName)
        : `upload-${Date.now()}`;
    const safeName = name.replace(/[\\/\0]/g, '_');
    const tempPath = path.join(os.tmpdir(), `adh-up-${Date.now()}-${safeName}`);
    fs.writeFileSync(tempPath, body);

    try {
      const remotePath = `${dir}/${safeName}`;
      const result = await runCommand(
        'adb',
        ['-s', device.udid, 'push', tempPath, remotePath],
        300_000,
      );
      if (result.code !== 0) {
        return reply
          .code(400)
          .send({ error: result.stderr.trim() || '上传失败' });
      }
      logDevice(
        request,
        device,
        'file.upload',
        `${remotePath} (${(body.length / 1024 / 1024).toFixed(1)} MB)`,
      );
      return { path: remotePath };
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
    }
  });

  /** 批量删除。 */
  /** 多选打包下载：adb pull 到临时目录后压成 zip。 */
  app.post('/api/devices/:id/files/archive', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const parsed = FilePathsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '没有选择文件' });
    }

    const paths = parsed.data.paths.map((item) => normalizeDevicePath(item));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-zip-'));
    const zip = new AdmZip();
    const usedNames = new Set<string>();
    let count = 0;

    try {
      for (const [index, remote] of paths.entries()) {
        const name = baseName(remote) || `item-${index}`;
        const local = path.join(tempDir, `${index}-${name}`);
        const result = await runCommand(
          'adb',
          ['-s', device.udid, 'pull', remote, local],
          300_000,
        );
        if (result.code !== 0 || !fs.existsSync(local)) continue;

        let entryName = name;
        if (usedNames.has(entryName)) entryName = `${index}-${name}`;
        usedNames.add(entryName);

        if (fs.statSync(local).isDirectory()) {
          zip.addLocalFolder(local, entryName);
        } else {
          zip.addLocalFile(local, '', entryName);
        }
        count += 1;
      }

      if (count === 0) {
        return reply.code(400).send({ error: '没有可打包的文件' });
      }

      const buffer = zip.toBuffer();
      logDevice(request, device, 'file.download', `打包下载 ${count} 个文件`);
      return reply
        .header('content-type', 'application/zip')
        .header(
          'content-disposition',
          `attachment; filename="files-${Date.now()}.zip"`,
        )
        .send(buffer);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  app.post('/api/devices/:id/files/delete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const parsed = FilePathsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请选择要删除的文件' });
    }

    const targets = parsed.data.paths.map((item) => normalizeDevicePath(item));
    for (const target of targets) {
      if (PROTECTED_PATHS.has(target)) {
        return reply.code(400).send({ error: `不允许删除 ${target}` });
      }
    }

    for (const target of targets) {
      const result = await runCommand(
        'adb',
        ['-s', device.udid, 'shell', 'rm', '-rf', shellQuote(target)],
        60_000,
      );
      if (result.code !== 0) {
        return reply
          .code(400)
          .send({ error: result.stderr.trim() || `删除 ${target} 失败` });
      }
    }
    logDevice(request, device, 'file.delete', targets.join(', ').slice(0, 400));
    return { ok: true, count: targets.length };
  });

  /** 重命名（同一目录内改名）。 */
  app.post('/api/devices/:id/files/rename', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const parsed = FileRenameBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请填写新名称' });
    }

    const source = normalizeDevicePath(parsed.data.path);
    if (PROTECTED_PATHS.has(source)) {
      return reply.code(400).send({ error: '不允许重命名该目录' });
    }

    const dir = source.slice(0, source.lastIndexOf('/')) || '/';
    const safeName = parsed.data.newName.replace(/[\\/\0]/g, '_').trim();
    if (!safeName) {
      return reply.code(400).send({ error: '名称不能为空' });
    }
    const destination = `${dir === '/' ? '' : dir}/${safeName}`;

    const result = await runCommand(
      'adb',
      ['-s', device.udid, 'shell', 'mv', shellQuote(source), shellQuote(destination)],
      60_000,
    );
    if (result.code !== 0) {
      return reply
        .code(400)
        .send({ error: result.stderr.trim() || '重命名失败' });
    }
    logDevice(request, device, 'file.rename', `${source} → ${destination}`);
    return { ok: true, path: destination };
  });

  /** 复制 / 移动到目标目录。 */
  app.post('/api/devices/:id/files/paste', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const parsed = FilePasteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不完整' });
    }

    const targetDir = normalizeDevicePath(parsed.data.targetDir);
    const sources = parsed.data.paths.map((item) => normalizeDevicePath(item));

    if (parsed.data.mode === 'move') {
      for (const source of sources) {
        if (PROTECTED_PATHS.has(source)) {
          return reply.code(400).send({ error: `不允许移动 ${source}` });
        }
      }
    }

    for (const source of sources) {
      const destination = `${targetDir === '/' ? '' : targetDir}/${baseName(source)}`;
      const args =
        parsed.data.mode === 'copy'
          ? ['-r', shellQuote(source), shellQuote(destination)]
          : [shellQuote(source), shellQuote(destination)];

      const result = await runCommand(
        'adb',
        [
          '-s',
          device.udid,
          'shell',
          parsed.data.mode === 'copy' ? 'cp' : 'mv',
          ...args,
        ],
        120_000,
      );
      if (result.code !== 0) {
        return reply.code(400).send({
          error: result.stderr.trim() || `${parsed.data.mode === 'copy' ? '复制' : '移动'}失败`,
        });
      }
    }
    logDevice(
      request,
      device,
      parsed.data.mode === 'copy' ? 'file.copy' : 'file.move',
      `${sources.length} 个 → ${targetDir}`,
    );
    return { ok: true, count: sources.length };
  });

  /* ---------------------------------------------------------------- */
  /* 设备运行状态（电量 / 内存 / 存储 / WiFi）                          */
  /* ---------------------------------------------------------------- */

  app.get('/api/devices/:id/battery', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    if (device.platform === 'ios') {
      const result = await runIos(['batterycheck', `--udid=${device.udid}`]);
      const battery = result?.code === 0 ? parseIosBattery(result.stdout) : null;
      if (!battery) {
        return reply
          .code(503)
          .send({ error: '读取 iOS 电量失败（确认 go-ios 可用且设备已信任）' });
      }
      return { battery };
    }

    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '仅支持 Android / iOS 设备' });
    }

    const result = await runCommand(
      'adb',
      ['-s', device.udid, 'shell', 'dumpsys', 'battery'],
      10_000,
    );
    return { battery: parseBattery(result.stdout) };
  });

  app.get('/api/devices/:id/runtime', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    if (device.platform === 'ios') {
      const [batteryResult, diskResult, wda] = await Promise.all([
        runIos(['batterycheck', `--udid=${device.udid}`]),
        runIos(['diskspace', `--udid=${device.udid}`]),
        wdaStatus(),
      ]);

      const stats: RuntimeStats = {
        battery:
          (batteryResult?.code === 0 && parseIosBattery(batteryResult.stdout)) || {
            level: null,
            charging: false,
            status: 'unknown',
            temperature: null,
          },
        memory: device.memoryMb
          ? { totalMb: device.memoryMb, usedMb: null }
          : null,
        storage:
          diskResult?.code === 0 ? parseIosStorage(diskResult.stdout) : null,
        wifi: wda
          ? { connected: true, ssid: null, enabled: true, ip: wda.ip }
          : null,
        uptimeSeconds: null,
      };
      return stats;
    }

    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '仅支持 Android / iOS 设备' });
    }

    const [battery, meminfo, df, wifi, wifiIp, uptime] = await Promise.all([
      runCommand('adb', ['-s', device.udid, 'shell', 'dumpsys', 'battery'], 10_000),
      runCommand('adb', ['-s', device.udid, 'shell', 'cat', '/proc/meminfo'], 10_000),
      runCommand('adb', ['-s', device.udid, 'shell', 'df', '-k', '/data'], 10_000),
      runCommand('adb', ['-s', device.udid, 'shell', 'cmd', 'wifi', 'status'], 10_000),
      runCommand('adb', ['-s', device.udid, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], 10_000),
      runCommand('adb', ['-s', device.udid, 'shell', 'cat', '/proc/uptime'], 10_000),
    ]);

    const wifiInfo = parseWifi(wifi.stdout);
    const ip = parseWifiIp(wifiIp.stdout);
    if (wifiInfo && ip) wifiInfo.ip = ip;

    const stats: RuntimeStats = {
      battery: parseBattery(battery.stdout),
      memory: parseMemory(meminfo.stdout),
      storage: parseStorage(df.stdout),
      wifi: wifiInfo,
      uptimeSeconds: parseUptime(uptime.stdout),
    };
    return stats;
  });

  /* ---------------------------------------------------------------- */
  /* iOS 实时控制（WDA）                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/devices/:id/ios/screenshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;
    if (device.platform !== 'ios') {
      return reply.code(400).send({ error: '仅支持 iOS 设备' });
    }
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }
    if (
      !deps.streams.isViewersAllowed(id, request.user?.id, request.user?.role)
    ) {
      return reply.code(403).send({ error: '控制者已关闭其他人查看' });
    }

    const { preset } = resolveQuality(
      (request.query as { quality?: string }).quality,
    );
    const png = await wdaScreenshot();
    if (!png) {
      return reply.code(503).send({
        error: '无法从 WDA 获取截图，请确认 WebDriverAgent 正在运行并已端口转发到 8100',
      });
    }

    let pipeline = sharp(png);
    if (preset.iosWidth > 0) {
      pipeline = pipeline.resize({
        width: preset.iosWidth,
        withoutEnlargement: true,
      });
    }
    const jpeg = await pipeline.jpeg({ quality: preset.iosQuality }).toBuffer();
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-store')
      .send(jpeg);
  });

  /** iOS 切换画质：直接调整 WDA MJPEG 参数，不重建连接。 */
  app.post('/api/devices/:id/ios/quality', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;
    if (device.platform !== 'ios') {
      return reply.code(400).send({ error: '仅支持 iOS 设备' });
    }
    if (!requireIosController(id, request, reply)) return reply;

    const body = z
      .object({ quality: z.enum(['low', 'medium', 'high', 'ultra']) })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }

    const quality = body.data.quality;
    await wdaApplyMjpegSettings(
      quality === 'low'
        ? { framerate: 30, quality: 25, scaling: 25 }
        : quality === 'medium'
          ? { framerate: 24, quality: 45, scaling: 50 }
          : quality === 'high'
            ? { framerate: 30, quality: 75, scaling: 100 }
            : { framerate: 30, quality: 95, scaling: 100 },
    );
    return { ok: true };
  });

  app.post('/api/devices/:id/ios/input', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;
    if (device.platform !== 'ios') {
      return reply.code(400).send({ error: '仅支持 iOS 设备' });
    }
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }
    if (!requireIosController(id, request, reply)) return reply;

    const parsed = IosInputBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '无效的输入指令' });
    }

    const payload = parsed.data;
    try {
      if (payload.type === 'tap') {
        const size = await wdaWindow();
        await wdaTap(payload.x * size.width, payload.y * size.height);
      } else if (payload.type === 'swipe') {
        const size = await wdaWindow();
        await wdaSwipe(
          payload.fromX * size.width,
          payload.fromY * size.height,
          payload.toX * size.width,
          payload.toY * size.height,
          payload.duration ?? 0.3,
        );
      } else if (payload.type === 'pinch') {
        // duration 是期望耗时（秒），换算成 WDA 的每秒缩放倍率
        await wdaPinch(payload.scale, 1 / (payload.duration ?? 0.4));
      } else if (payload.type === 'button') {
        await wdaPressButton(payload.name);
      } else if (payload.type === 'appSwitcher') {
        await wdaAppSwitcher();
      } else if (payload.type === 'screen') {
        if (payload.on) await wdaUnlock();
        else await wdaLock();
        logDevice(
          request,
          device,
          'input.screen',
          payload.on ? '亮屏' : '息屏',
        );
      } else if (payload.type === 'screenToggle') {
        const unlocked = iosScreenUnlocked.get(device.id) ?? true;
        if (unlocked) await wdaLock();
        else await wdaUnlock();
        iosScreenUnlocked.set(device.id, !unlocked);
        logDevice(
          request,
          device,
          'input.screen',
          unlocked ? '息屏' : '亮屏',
        );
      } else if (payload.type === 'mute') {
        // iOS 没有静音接口，连续按音量减到 0
        for (let i = 0; i < 10; i += 1) {
          await wdaPressButton('volumeDown');
        }
        logDevice(request, device, 'input.key', '静音');
      } else {
        await wdaTypeText(payload.text);
      }

      // 记录 iOS 输入操作（触摸日志暂时关闭，后期需要时取消注释）
      if (payload.type === 'tap' || payload.type === 'swipe') {
        // const now = Date.now();
        // if (now - (lastIosTouchAt.get(device.id) ?? 0) >= 1200) {
        //   lastIosTouchAt.set(device.id, now);
        //   const detail = ...
        //   logDevice(request, device, 'input.touch', detail);
        // }
      } else if (payload.type === 'text') {
        logDevice(
          request,
          device,
          'input.text',
          `输入 ${payload.text.length} 个字符`,
        );
      } else if (payload.type === 'button') {
        logDevice(request, device, 'input.key', payload.name);
      } else if (payload.type === 'appSwitcher') {
        logDevice(request, device, 'input.key', '任务切换');
      }

      return { ok: true };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : 'WDA 操作失败',
      });
    }
  });

  /** 设备网络信息：SSID（iOS 不支持）+ IP，卡片与详情共用。 */
  app.get('/api/devices/:id/network', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    if (device.platform === 'ios') {
      const status = await wdaStatus();
      return {
        platform: 'ios',
        connected: Boolean(status),
        ssid: null,
        ip: status?.ip ?? null,
      };
    }

    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '仅支持 Android / iOS 设备' });
    }

    const [wifi, ip] = await Promise.all([
      runCommand('adb', ['-s', device.udid, 'shell', 'cmd', 'wifi', 'status'], 8_000),
      runCommand(
        'adb',
        ['-s', device.udid, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
        8_000,
      ),
    ]);
    const info = parseWifi(wifi.stdout);
    return {
      platform: 'android',
      connected: info?.connected ?? false,
      ssid: info?.ssid ?? null,
      ip: parseWifiIp(ip.stdout),
    };
  });

  /** WDA 自带的 MJPEG 流，用于高帧率预览（~10fps）。 */
  app.get('/api/devices/:id/ios/mjpeg', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;
    if (device.platform !== 'ios') {
      return reply.code(400).send({ error: '仅支持 iOS 设备' });
    }
    if (device.locked) {
      return reply.code(403).send({ error: '设备已被管理员锁定' });
    }
    if (
      !deps.streams.isViewersAllowed(id, request.user?.id, request.user?.role)
    ) {
      return reply.code(403).send({ error: '控制者已关闭其他人查看' });
    }

    const port = await ensureMjpegPort(device.udid);
    if (!port) {
      return reply
        .code(503)
        .send({ error: '无法建立 WDA MJPEG 转发，请确认 go-ios 可用' });
    }

    const { quality } = resolveQuality(
      (request.query as { quality?: string }).quality,
    );

    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      return reply.code(503).send({ error: 'WDA MJPEG 流不可用' });
    }
    if (!upstream.ok || !upstream.body) {
      return reply.code(503).send({ error: 'WDA MJPEG 流不可用' });
    }

    reply.hijack();

    // 直接透传 WDA 的 MJPEG：帧率/质量/缩放交给 WDA 自己控制，
    // 避免服务端逐帧解码再编码，延迟可以降一个数量级
    await wdaApplyMjpegSettings(
      quality === 'low'
        ? { framerate: 30, quality: 25, scaling: 25 }
        : quality === 'medium'
          ? { framerate: 24, quality: 45, scaling: 50 }
          : quality === 'high'
            ? { framerate: 30, quality: 75, scaling: 100 }
            : { framerate: 30, quality: 95, scaling: 100 },
    );

    reply.raw.writeHead(200, {
      'content-type':
        upstream.headers.get('content-type') ??
        'multipart/x-mixed-replace; boundary=--BoundaryString',
      'cache-control': 'no-store',
      connection: 'close',
    });
    const stream = Readable.fromWeb(upstream.body as never);
    stream.pipe(reply.raw);
    request.raw.on('close', () => stream.destroy());
    return;
  });

  /* ---------------------------------------------------------------- */
  /* 设备应用（APK）管理                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/devices/:id/apps', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    if (device.platform === 'ios') {
      const result = await runIos(
        ['apps', '--list', `--udid=${device.udid}`],
        60_000,
      );
      if (!result || result.code !== 0) {
        return reply.code(400).send({ error: '读取 iOS 应用列表失败' });
      }

      const packages = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[A-Za-z0-9_.-]+\s+/.test(line))
        .map((line) => {
          const parts = line.split(/\s+/);
          const name = parts[0]!;
          const hasVersion = parts.length > 2;
          return {
            name,
            label: hasVersion ? parts.slice(1, -1).join(' ') : (parts[1] ?? ''),
            version: hasVersion ? parts[parts.length - 1]! : null,
            size: null,
            installedAt: null,
            lastUsedAt: null,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

      return { packages };
    }

    const { system } = request.query as { system?: string };
    const includeSystem = system === '1';
    const flag = includeSystem ? '' : '-3 ';

    // 一条 shell 循环同时拿到包名和 APK 大小，避免 70 多次 adb 往返
    const sizeScript =
      `pm list packages ${flag}-f | while IFS= read -r line; do ` +
      `case "$line" in package:*) ;; *) continue ;; esac; ` +
      `pkg=\${line##*=}; p=\${line#package:}; p=\${p%=*}; ` +
      `s=$(stat -c %s "$p" 2>/dev/null); echo "$pkg|$s"; done`;

    const [listResult, metaResult, usageResult] = await Promise.all([
      runCommand('adb', ['-s', device.udid, 'shell', sizeScript], 120_000),
      runCommand(
        'adb',
        ['-s', device.udid, 'shell', 'dumpsys', 'package', 'packages'],
        60_000,
      ),
      runCommand('adb', ['-s', device.udid, 'shell', 'dumpsys', 'usagestats'], 30_000),
    ]);

    const sizes =
      listResult.code === 0 ? parseAppSizes(listResult.stdout) : new Map<string, number>();
    const meta: Map<string, PackageMeta> =
      metaResult.code === 0 ? parsePackageMeta(metaResult.stdout) : new Map();
    const lastUsed =
      usageResult.code === 0 ? parseLastUsed(usageResult.stdout) : new Map<string, string>();

    let packages = [...sizes.keys()];
    if (packages.length === 0) {
      // 个别 ROM 不支持上面的循环，退回只列包名
      const fallback = await runCommand(
        'adb',
        ['-s', device.udid, 'shell', 'pm', 'list', 'packages', ...(includeSystem ? [] : ['-3'])],
        30_000,
      );
      if (fallback.code !== 0) {
        return reply.code(400).send({ error: '读取应用列表失败' });
      }
      packages = fallback.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length).trim())
        .filter(Boolean);
    }
    packages.sort((a, b) => a.localeCompare(b));

    return {
      packages: packages.map((name) => ({
        name,
        version: meta.get(name)?.version ?? null,
        size: sizes.get(name) ?? null,
        installedAt: meta.get(name)?.installedAt ?? null,
        lastUsedAt: lastUsed.get(name) ?? null,
      })),
    };
  });

  /** 从设备拉取 APK、解析 resources.arsc 里的图标，缓存后返回 PNG。 */
  app.get('/api/devices/:id/apps/icon', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { package: packageName, version } = request.query as {
      package?: string;
      version?: string;
    };
    if (!packageName || !/^[A-Za-z0-9_.]+$/.test(packageName)) {
      return reply.code(400).send({ error: '缺少有效的 package' });
    }

    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;
    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '仅支持 Android 设备' });
    }

    const key = deps.icons.key(packageName, version ?? null);
    await deps.icons.ensureLocal(key);

    let data = deps.icons.read(key);
    if (!data) {
      // 解析图标要拉整个 APK，串行排队，避免一次打开列表把 adb 打满
      data = await enqueueIcon(async () => {
        const cached = deps.icons.read(key);
        if (cached) return cached;
        const fetched = await fetchAppIcon(device.udid, packageName);
        if (fetched) deps.icons.save(key, fetched);
        return fetched;
      });
    }

    if (!data) {
      return reply.code(404).send({ error: '没有解析到图标' });
    }

    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=86400')
      .send(data);
  });

  /** 把设备上已安装的 APK 导出到浏览器。 */
  app.get('/api/devices/:id/apps/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const { package: packageName } = request.query as { package?: string };
    if (!packageName) {
      return reply.code(400).send({ error: '缺少应用包名' });
    }

    const pathResult = await runCommand(
      'adb',
      ['-s', device.udid, 'shell', 'pm', 'path', packageName],
      10_000,
    );
    const match = /package:(.+)/.exec(pathResult.stdout);
    if (!match) {
      return reply.code(404).send({ error: '应用未安装或无法读取路径' });
    }
    const apkPath = match[1]!.trim();

    const data = await runCommandBuffer(
      'adb',
      ['-s', device.udid, 'exec-out', 'cat', apkPath],
      180_000,
    );
    if (data.code !== 0 || data.stdout.length === 0) {
      return reply.code(400).send({ error: '导出安装包失败' });
    }

    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${packageName}.apk`)}`,
      )
      .send(data.stdout);
  });

  app.post('/api/devices/:id/apps/uninstall', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await requireLocalDevice(id, reply);
    if (!device) return reply;

    const body = request.body as { package?: string } | undefined;
    const packageName = body?.package;
    if (!packageName) {
      return reply.code(400).send({ error: '缺少应用包名' });
    }

    if (device.platform === 'ios') {
      const result = await runIos(
        ['uninstall', packageName, `--udid=${device.udid}`],
        90_000,
      );
      const output = result
        ? `${result.stdout}\n${result.stderr}`.trim()
        : '';
      if (!result || result.code !== 0) {
        return reply.code(400).send({ error: output || '卸载失败' });
      }
      logDevice(request, device, 'app.uninstall', packageName);
      return { ok: true };
    }

    const result = await runCommand(
      'adb',
      ['-s', device.udid, 'uninstall', packageName],
      90_000,
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 || !/success/i.test(result.stdout)) {
      return reply.code(400).send({ error: output || '卸载失败' });
    }
    logDevice(request, device, 'app.uninstall', packageName);
    return { ok: true };
  });

  app.get('/api/devices/:id/thumbnail', async (request, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await deps.thumbnails.ensureLocal(id);
    const data = deps.thumbnails.read(id);
    if (!data) return reply.code(404).send({ error: 'thumbnail not found' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-cache')
      .send(data);
  });

  app.delete('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    await deps.queries.removeDevice(device.agentId, device.udid);
    deps.thumbnails.remove(id);
    deps.hub.broadcast({ t: 'device.removed', deviceId: id });
    return reply.code(204).send();
  });

  /** agent 用自身 key 上传设备缩略图。 */
  app.put('/api/agent/devices/:udid/thumbnail', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'missing agent key' });
    const agent = await deps.queries.findAgentByToken(token);
    if (!agent) return reply.code(401).send({ error: 'invalid agent key' });

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty image body' });
    }
    if (body.length > 2 * 1024 * 1024) {
      return reply.code(413).send({ error: 'thumbnail too large' });
    }

    const { udid } = request.params as { udid: string };
    const row = await deps.queries.findDevice(agent.id, udid);
    if (!row) return reply.code(404).send({ error: 'device not found' });

    deps.thumbnails.save(row.id, body);
    await deps.queries.touchAgent(agent.id);
    const device = await deps.queries.markThumbnail(row.id);
    if (device) deps.hub.broadcast({ t: 'device.updated', device });
    return reply.code(204).send();
  });
}