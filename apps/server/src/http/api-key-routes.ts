import type { FastifyInstance } from 'fastify';
import type { ApiKeyService } from '../auth/api-keys.js';

export interface ApiKeyRouteDeps {
  apiKeys: ApiKeyService;
}

/** 外部 agent / MCP 使用的长期 Key，每个登录用户只能看和操作自己的。 */
export function registerApiKeyRoutes(
  app: FastifyInstance,
  deps: ApiKeyRouteDeps,
): void {
  app.get('/api/api-keys', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    // 没有就补一把；明文随 Key 一起存，所以总能回显给本人
    const current = await deps.apiKeys.ensureForUser(user.id);
    const keys = await deps.apiKeys.list(user.id);
    return { keys, key: current.key };
  });

  app.post('/api/api-keys/reset', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const created = await deps.apiKeys.reset(user.id);
    return reply.code(201).send(created);
  });

  app.post('/api/api-keys', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    // 每个用户只有一把默认 Key，只能重置，不能主动新增
    return reply
      .code(400)
      .send({ error: '每个用户只有一把默认 Key，请使用重置接口' });
  });

  app.delete('/api/api-keys/:id', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    // 只能删自己的 Key，superadmin 也一样
    await deps.apiKeys.remove(id, user.id);
    return { ok: true };
  });
}
