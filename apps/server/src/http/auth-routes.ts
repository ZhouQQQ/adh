import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES, type AuthService } from '../auth/service.js';
import { bearerToken } from '../auth/token.js';

interface AuthRouteDeps {
  auth: AuthService;
}

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

const CreateUserBody = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(6).max(128),
  role: z.enum(ROLES),
  displayName: z.string().max(64).nullable().optional(),
});

const UpdateUserBody = z.object({
  displayName: z.string().max(64).nullable().optional(),
  role: z.enum(ROLES).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(6).max(128).optional(),
});

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  username: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '用户名和密码不能为空' });
    }

    const result = await deps.auth.login(
      parsed.data.username.trim(),
      parsed.data.password,
      request.ip,
    );
    if (!result) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    return result;
  });

  app.post('/api/auth/logout', async (request) => {
    const token = bearerToken(request);
    if (token) await deps.auth.logout(token);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({
    user: request.user ?? null,
  }));

  app.get('/api/users', async () => ({
    users: await deps.auth.listUsers(),
  }));

  app.post('/api/users', async (request, reply) => {
    const parsed = CreateUserBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法（用户名 1-64 位，密码至少 6 位）' });
    }

    const existing = await deps.auth.getByUsername(parsed.data.username);
    if (existing) {
      return reply.code(409).send({ error: '用户名已存在' });
    }

    const user = await deps.auth.createUser(parsed.data);
    await deps.auth.writeAudit({
      userId: request.user?.id,
      username: request.user?.username,
      role: request.user?.role,
      action: 'user.create',
      target: user.username,
      status: 201,
      ip: request.ip,
      detail: `角色=${user.role === 'admin' ? '管理员' : '操作员'}`,
    });
    return reply.code(201).send({ user });
  });

  app.patch('/api/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateUserBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }

    const target = await deps.auth.getUser(id);
    if (!target) return reply.code(404).send({ error: '用户不存在' });

    const nextRole = parsed.data.role ?? target.role;
    const nextEnabled = parsed.data.enabled ?? target.enabled;
    if (
      target.role === 'admin' &&
      target.enabled &&
      (nextRole !== 'admin' || !nextEnabled)
    ) {
      if ((await deps.auth.countAdmins()) <= 1) {
        return reply.code(400).send({ error: '至少要保留一个启用的管理员' });
      }
    }

    const user = await deps.auth.updateUser(id, parsed.data);
    if (!user) return reply.code(404).send({ error: '用户不存在' });

    const changes: string[] = [];
    if (parsed.data.role !== undefined) {
      changes.push(`角色=${parsed.data.role === 'admin' ? '管理员' : '操作员'}`);
    }
    if (parsed.data.enabled !== undefined) {
      changes.push(parsed.data.enabled ? '启用账号' : '禁用账号');
    }
    if (parsed.data.displayName !== undefined) changes.push('修改显示名');
    if (parsed.data.password !== undefined) changes.push('重置密码');

    await deps.auth.writeAudit({
      userId: request.user?.id,
      username: request.user?.username,
      role: request.user?.role,
      action: 'user.update',
      target: user.username,
      status: 200,
      ip: request.ip,
      detail: changes.join('，') || '更新资料',
    });
    return { user };
  });

  app.delete('/api/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user?.id) {
      return reply.code(400).send({ error: '不能删除当前登录用户' });
    }

    const target = await deps.auth.getUser(id);
    if (!target) return reply.code(404).send({ error: '用户不存在' });

    if (target.role === 'admin' && target.enabled) {
      if ((await deps.auth.countAdmins()) <= 1) {
        return reply.code(400).send({ error: '至少要保留一个启用的管理员' });
      }
    }

    await deps.auth.deleteUser(id);
    await deps.auth.writeAudit({
      userId: request.user?.id,
      username: request.user?.username,
      role: request.user?.role,
      action: 'user.delete',
      target: target.username,
      status: 204,
      ip: request.ip,
      detail: '删除用户',
    });
    return reply.code(204).send();
  });

  app.get('/api/audit', async (request, reply) => {
    const parsed = AuditQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }

    const result = await deps.auth.listAudit({
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
      username: parsed.data.username,
      action: parsed.data.action,
    });
    return { logs: result.rows, total: result.total };
  });
}