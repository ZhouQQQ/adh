import type { FastifyInstance } from 'fastify';
import type { ApiKeyService } from '../auth/api-keys.js';

export interface ApiKeyRouteDeps {
  apiKeys: ApiKeyService;
}

/** 外部 agent / MCP 使用的长期 Key，所有登录用户都可以生成自己的。 */
export function registerApiKeyRoutes(
  app: FastifyInstance,
  deps: ApiKeyRouteDeps,
): void {
  app.get('/api/api-keys', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    // 首次进入自动补一把；响应里的 key 只在这次创建时出现
    const auto = await deps.apiKeys.ensureForUser(user.id);
    // 超级管理员看全部，普通用户只看自己的
    const keys =
      user.role === 'superadmin'
        ? await deps.apiKeys.listAll()
        : await deps.apiKeys.list(user.id);
    return { keys, key: auto?.key };
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
    if (user.role === 'superadmin') {
      await deps.apiKeys.remove(id);
    } else {
      await deps.apiKeys.remove(id, user.id);
    }
    return { ok: true };
  });
}