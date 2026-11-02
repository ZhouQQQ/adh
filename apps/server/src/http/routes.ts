import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  BUILTIN_AGENT_ID,
  UpdateAgentBodySchema,
  type AgentSummary,
  type DeviceSummary,
} from '@adh/protocol';
import { runCommand, runCommandBuffer } from '@adh/device-host';
import { SERVER_VERSION } from '../config.js';
import type { CommandBus } from '../command-bus.js';
import type { Queries } from '../db/queries.js';
import { baseName, normalizeDevicePath, parseLsOutput } from '../files/ls.js';
import type { AgentRegistry } from '../registry.js';
import { PackageStore, packageKind, type PackageKind } from '../storage/packages.js';
import type { OssStore } from '../storage/oss.js';
import type { ThumbnailStore } from '../storage/thumbnails.js';
import type { StreamManager } from '../stream/manager.js';
import type { WebHub } from '../ws/web-hub.js';

export interface HttpDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  thumbnails: ThumbnailStore;
  packages: PackageStore;
  oss: OssStore | null;
  commands: CommandBus;
  streams: StreamManager;
  port: number;
}

const CreateAgentBody = z.object({
  name: z.string().trim().min(1).max(40),
});

const InstallBody = z.object({
  packageId: z.string().regex(/^[a-f0-9]{64}$/),
});

const RenamePackageBody = z.object({
  name: z.string().trim().min(1).max(160),
});

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

const UpdateDeviceBody = z.object({
  publishedAt: z.number().int().min(0).optional(),
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

/** 从 dumpsys package 输出里提取 versionName。 */
function parsePackageVersions(raw: string): Map<string, string> {
  const versions = new Map<string, string>();
  let current: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*Package \[([^\]]+)\]/.exec(line);
    if (header) {
      current = header[1] ?? null;
      continue;
    }
    if (!current) continue;
    const version = /^\s+versionName=(\S+)/.exec(line);
    if (version) {
      versions.set(current, version[1] ?? '');
      current = null;
    }
  }
  return versions;
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
  /* Agent 管理                                                        */
  /* ---------------------------------------------------------------- */

  app.get('/api/agents', async () => {
    return deps.queries
      .listAgents()
      .map((agent) => withOnline(agent, deps.registry));
  });

  /** 详情：返回完整 Key，便于随时查看接入命令。 */
  app.get('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = deps.queries.getAgent(id);
    const summary = deps.queries.getAgentSummary(id);
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

    const existing = deps.queries.getAgent(id);
    if (!existing) return reply.code(404).send({ error: 'agent not found' });

    const name = parsed.data.name;
    const conflict = deps.queries.findAgentByName(name);
    if (conflict && conflict.id !== id) {
      return reply.code(409).send({ error: '同名 Agent 已存在' });
    }

    const row = deps.queries.renameAgent(id, name);
    if (!row) return reply.code(404).send({ error: 'agent not found' });

    const summary = deps.queries.getAgentSummary(id);
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
    const existing = deps.queries.findAgentByName(parsed.data.name);
    if (existing) {
      return reply.code(409).send({ error: '同名 Agent 已存在' });
    }

    const row = deps.queries.createAgent(parsed.data.name);
    const summary = deps.queries.getAgentSummary(row.id);
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
    const row = deps.queries.rotateAgentToken(id);
    if (!row) return reply.code(404).send({ error: 'agent not found' });

    const summary = deps.queries.getAgentSummary(id);
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
    const agentDevices = deps.queries.listDevices(id);
    if (!deps.queries.deleteAgent(id)) {
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
    const devices: DeviceSummary[] = deps.queries.listDevices();
    return devices.map((device) => ({
      ...(isOnline(device.agentId) ? device : { ...device, status: 'offline' as const }),
      inUse: inUse.has(device.id),
    }));
  });

  app.get('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    return { ...device, inUse: deps.streams.isInUse(id) };
  });

  /** 编辑设备元信息（目前只有发布时间）。 */
  app.patch('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateDeviceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }

    const updated = deps.queries.updateDeviceMeta(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: '设备不存在' });

    const device = { ...updated, inUse: deps.streams.isInUse(id) };
    deps.hub.broadcast({ t: 'device.updated', device });
    return device;
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

    const device = deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });

    deps.thumbnails.save(id, body);
    const updated = deps.queries.setManualThumbnail(id);
    if (!updated) return reply.code(500).send({ error: '保存失败' });

    const summary = { ...updated, inUse: deps.streams.isInUse(id) };
    deps.hub.broadcast({ t: 'device.updated', device: summary });
    return summary;
  });

  /** 创建投屏会话，返回 sessionId 供浏览器连接 /ws/stream/:id。 */
  app.post('/api/devices/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await deps.streams.create(id);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : '无法创建投屏会话',
      });
    }
  });

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
    return {
      id: record.id,
      name: record.name,
      size: record.size,
      kind: record.kind,
    };
  });

  /** 已上传的安装包列表。 */
  app.get('/api/packages', async () => {
    return { packages: deps.packages.list() };
  });

  /** 重命名安装包（仅改显示名，后缀不可变）。 */
  app.patch('/api/packages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RenamePackageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '名称不能为空' });
    }

    const record = deps.packages.record(id);
    if (!record || !deps.packages.has(id)) {
      return reply.code(404).send({ error: '安装包不存在' });
    }

    const name = parsed.data.name.trim();
    if (packageKind(name) !== record.kind) {
      return reply.code(400).send({
        error: `文件后缀必须是 .${record.kind}`,
      });
    }

    const next = deps.packages.rename(id, name);
    if (!next) return reply.code(404).send({ error: '安装包不存在' });
    return { package: next };
  });

  /** 删除已上传的安装包。 */
  app.delete('/api/packages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deps.packages.record(id)) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    deps.packages.remove(id);
    return reply.code(204).send();
  });

  const packageContentType = (kind: PackageKind): string =>
    kind === 'ipa'
      ? 'application/octet-stream'
      : 'application/vnd.android.package-archive';

  /** 前端导出安装包（无需 agent 鉴权）。 */
  app.get('/api/packages/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = deps.packages.record(id);
    if (!record || !(await deps.packages.ensureLocal(id))) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    const data = deps.packages.read(id);
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
    const agent = token ? deps.queries.findAgentByToken(token) : null;
    if (!agent) return reply.code(401).send({ error: 'invalid agent key' });

    const { id } = request.params as { id: string };
    const record = deps.packages.record(id);
    if (!record || !(await deps.packages.ensureLocal(id))) {
      return reply.code(404).send({ error: '安装包不存在' });
    }
    const data = deps.packages.read(id);
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

    const device = deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '目前只支持安装 APK' });
    }

    const record = deps.packages.record(parsed.data.packageId);
    if (!record) {
      return reply.code(404).send({ error: '安装包不存在，请重新上传' });
    }
    if (record.kind === 'ipa') {
      return reply.code(400).send({ error: 'IPA 只能上传留存，暂不支持安装' });
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
          deps.packages.path(parsed.data.packageId),
        ],
        300_000,
      );
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.code !== 0 || !/success/i.test(result.stdout)) {
        return reply.code(400).send({ error: output || '安装失败' });
      }
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

  const requireLocalDevice = (
    deviceId: string,
    reply: FastifyReply,
  ): DeviceSummary | null => {
    const device = deps.queries.getDevice(deviceId);
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

  app.get('/api/devices/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = requireLocalDevice(id, reply);
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
    const device = requireLocalDevice(id, reply);
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
    const device = requireLocalDevice(id, reply);
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
  app.post('/api/devices/:id/files/delete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = requireLocalDevice(id, reply);
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
    return { ok: true, count: targets.length };
  });

  /** 重命名（同一目录内改名）。 */
  app.post('/api/devices/:id/files/rename', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = requireLocalDevice(id, reply);
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
    return { ok: true, path: destination };
  });

  /** 复制 / 移动到目标目录。 */
  app.post('/api/devices/:id/files/paste', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = requireLocalDevice(id, reply);
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
    return { ok: true, count: sources.length };
  });

  /* ---------------------------------------------------------------- */
  /* 设备应用（APK）管理                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/devices/:id/apps', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = requireLocalDevice(id, reply);
    if (!device) return reply;

    if (device.platform !== 'android') {
      return reply.code(400).send({ error: '仅支持 Android 设备' });
    }

    const { system } = request.query as { system?: string };
    const includeSystem = system === '1';

    const result = await runCommand(
      'adb',
      includeSystem
        ? ['-s', device.udid, 'shell', 'pm', 'list', 'packages']
        : ['-s', device.udid, 'shell', 'pm', 'list', 'packages', '-3'],
      30_000,
    );
    if (result.code !== 0) {
      return reply.code(400).send({ error: '读取应用列表失败' });
    }

    const packages = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    // 版本号需要额外一次 dumpsys，失败就只返回包名
    let versions = new Map<string, string>();
    try {
      const dump = await runCommand(
        'adb',
        ['-s', device.udid, 'shell', 'dumpsys', 'package', 'packages'],
        60_000,
      );
      if (dump.code === 0) versions = parsePackageVersions(dump.stdout);
    } catch {
      /* 部分 ROM 限制 dumpsys，忽略 */
    }

    return {
      packages: packages.map((name) => ({
        name,
        version: versions.get(name) ?? null,
      })),
    };
  });

  /** 把设备上已安装的 APK 导出到浏览器。 */
  app.get('/api/devices/:id/apps/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = requireLocalDevice(id, reply);
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
    const device = requireLocalDevice(id, reply);
    if (!device) return reply;

    const body = request.body as { package?: string } | undefined;
    const packageName = body?.package;
    if (!packageName) {
      return reply.code(400).send({ error: '缺少应用包名' });
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
    const device = deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    deps.queries.removeDevice(device.agentId, device.udid);
    deps.thumbnails.remove(id);
    deps.hub.broadcast({ t: 'device.removed', deviceId: id });
    return reply.code(204).send();
  });

  /** 清空所有离线设备记录。 */
  app.post('/api/devices/cleanup', async () => {
    const removed = deps.queries.purgeOfflineDevices();
    for (const device of removed) {
      deps.thumbnails.remove(device.id);
      deps.hub.broadcast({ t: 'device.removed', deviceId: device.id });
    }
    return { removed: removed.length };
  });

  /** agent 用自身 key 上传设备缩略图。 */
  app.put('/api/agent/devices/:udid/thumbnail', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'missing agent key' });
    const agent = deps.queries.findAgentByToken(token);
    if (!agent) return reply.code(401).send({ error: 'invalid agent key' });

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty image body' });
    }
    if (body.length > 2 * 1024 * 1024) {
      return reply.code(413).send({ error: 'thumbnail too large' });
    }

    const { udid } = request.params as { udid: string };
    const row = deps.queries.findDevice(agent.id, udid);
    if (!row) return reply.code(404).send({ error: 'device not found' });

    deps.thumbnails.save(row.id, body);
    deps.queries.touchAgent(agent.id);
    const device = deps.queries.markThumbnail(row.id);
    if (device) deps.hub.broadcast({ t: 'device.updated', device });
    return reply.code(204).send();
  });
}