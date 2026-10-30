import type { FastifyInstance } from 'fastify';
import type { DeviceSummary } from '@adh/protocol';
import { SERVER_VERSION } from '../config.js';
import type { Queries } from '../db/queries.js';
import type { AgentRegistry } from '../registry.js';

export interface HttpDeps {
  queries: Queries;
  registry: AgentRegistry;
}

export async function registerHttpRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    version: SERVER_VERSION,
    uptime: Math.round(process.uptime()),
    onlineAgents: deps.registry.ids().length,
  }));

  app.get('/api/agents', async () => {
    const online = new Set(deps.registry.ids());
    return deps.queries
      .listAgents()
      .map((agent) => ({ ...agent, online: online.has(agent.id) }));
  });

  app.get('/api/devices', async () => {
    const online = new Set(deps.registry.ids());
    const devices: DeviceSummary[] = deps.queries.listDevices();
    // 设备状态跟随 agent 在线状态，避免 agent 异常退出后残留 online
    return devices.map((device) =>
      online.has(device.agentId) ? device : { ...device, status: 'offline' },
    );
  });

  app.get('/api/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    return device;
  });
}