import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BUILTIN_AGENT_ID,
  UpdateAgentBodySchema,
  type AgentSummary,
  type DeviceSummary,
} from '@adh/protocol';
import { runCommand } from '@adh/device-host';
import { SERVER_VERSION } from '../config.js';
import type { CommandBus } from '../command-bus.js';
import type { Queries } from '../db/queries.js';
import type { AgentRegistry } from '../registry.js';
import { PackageStore } from '../storage/packages.js';
import type { ThumbnailStore } from '../storage/thumbnails.js';
import type { StreamManager } from '../stream/manager.js';
import type { WebHub } from '../ws/web-hub.js';

export interface HttpDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  thumbnails: ThumbnailStore;
  packages: PackageStore;
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

  app.get('/api/health', async () => ({
    ok: true,
    version: SERVER_VERSION,
    uptime: Math.round(process.uptime()),
    onlineAgents: deps.registry.ids().length,
  }));

  app.get('/api/server-info', async () => ({
    version: SERVER_VERSION,
    port: deps.port,
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
    const devices: DeviceSummary[] = deps.queries.listDevices();
    return devices.map((device) =>
      isOnline(device.agentId) ? device : { ...device, status: 'offline' },
    );
  });

  app.get('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    return device;
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

  /** 上传 APK，按 sha256 去重存储。 */
  app.post('/api/packages', async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: '安装包内容为空' });
    }
    if (body.length > 512 * 1024 * 1024) {
      return reply.code(413).send({ error: '安装包超过 512MB' });
    }

    const id = PackageStore.hash(body);
    deps.packages.save(id, body);

    const rawName = request.headers['x-file-name'];
    const name =
      typeof rawName === 'string' && rawName
        ? decodeURIComponent(rawName)
        : `${id.slice(0, 8)}.apk`;

    return { id, name, size: body.length };
  });

  /** agent 下载安装包（用自身 Key 鉴权）。 */
  app.get('/api/packages/:id/download', async (request, reply) => {
    const token = bearerToken(request);
    const agent = token ? deps.queries.findAgentByToken(token) : null;
    if (!agent) return reply.code(401).send({ error: 'invalid agent key' });

    const { id } = request.params as { id: string };
    const data = deps.packages.read(id);
    if (!data) return reply.code(404).send({ error: '安装包不存在' });

    return reply
      .header('content-type', 'application/vnd.android.package-archive')
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
    if (!deps.packages.has(parsed.data.packageId)) {
      return reply.code(404).send({ error: '安装包不存在，请重新上传' });
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

  app.get('/api/devices/:id/thumbnail', async (request, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
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