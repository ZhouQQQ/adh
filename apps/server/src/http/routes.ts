import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BUILTIN_AGENT_ID, type AgentSummary, type DeviceSummary } from '@adh/protocol';
import { SERVER_VERSION } from '../config.js';
import type { Queries } from '../db/queries.js';
import type { AgentRegistry } from '../registry.js';
import type { ThumbnailStore } from '../storage/thumbnails.js';
import type { WebHub } from '../ws/web-hub.js';

export interface HttpDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  thumbnails: ThumbnailStore;
  port: number;
}

const CreateAgentBody = z.object({
  name: z.string().trim().min(1).max(40),
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

  app.get('/api/devices/:id/thumbnail', async (request, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = deps.thumbnails.read(id);
    if (!data) return reply.code(404).send({ error: 'thumbnail not found' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-cache')
      .send(data);
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