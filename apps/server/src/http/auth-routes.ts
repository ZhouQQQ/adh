import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES, isAdminRole, roleLabel, type AuthService } from '../auth/service.js';
import { bearerToken } from '../auth/token.js';

interface AuthRouteDeps {
  auth: AuthService;
  /** 登录成功后的回调：把同账号的旧连接挤下线。 */
  onLogin?: (userId: string) => void;
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
  /** 起始时间（毫秒时间戳），用于快捷时间范围过滤。 */
  since: z.coerce.number().int().min(0).optional(),
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
    // 踢掉该账号此前在别处的登录（WebSocket 也会立即断开）
    deps.onLogin?.(result.user.id);
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
    if (request.user?.role !== 'superadmin' && parsed.data.role !== 'operator') {
      return reply.code(403).send({ error: '管理员只能创建普通用户' });
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
      detail: `创建用户「${user.username}」，角色=${roleLabel(user.role)}`,
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
    if (request.user?.role !== 'superadmin') {
      if (target.role === 'superadmin') {
        return reply.code(403).send({ error: '只有超级管理员可以管理超级管理员' });
      }
      // 管理员可以改管理员 / 普通用户的资料和密码，但不能调整角色
      if (parsed.data.role !== undefined && parsed.data.role !== target.role) {
        return reply.code(403).send({ error: '管理员不能修改用户角色' });
      }
    }

    const nextRole = parsed.data.role ?? target.role;
    const nextEnabled = parsed.data.enabled ?? target.enabled;
    if (
      isAdminRole(target.role) &&
      target.enabled &&
      (!isAdminRole(nextRole) || !nextEnabled)
    ) {
      if ((await deps.auth.countAdmins()) <= 1) {
        return reply.code(400).send({ error: '至少要保留一个启用的管理员' });
      }
    }
    if (
      target.role === 'superadmin' &&
      target.enabled &&
      (nextRole !== 'superadmin' || !nextEnabled)
    ) {
      if ((await deps.auth.countSuperAdmins()) <= 1) {
        return reply.code(400).send({ error: '至少要保留一个启用的超级管理员' });
      }
    }

    const user = await deps.auth.updateUser(id, parsed.data);
    if (!user) return reply.code(404).send({ error: '用户不存在' });

    const changes: string[] = [];
    if (parsed.data.role !== undefined) {
      changes.push(`角色=${roleLabel(parsed.data.role)}`);
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
      detail: `修改用户「${user.username}」：${changes.join('，') || '更新资料'}`,
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
    if (request.user?.role !== 'superadmin' && target.role === 'superadmin') {
      return reply.code(403).send({ error: '只有超级管理员可以删除超级管理员' });
    }

    if (isAdminRole(target.role) && target.enabled) {
      if ((await deps.auth.countAdmins()) <= 1) {
        return reply.code(400).send({ error: '至少要保留一个启用的管理员' });
      }
    }
    if (target.role === 'superadmin' && target.enabled) {
      if ((await deps.auth.countSuperAdmins()) <= 1) {
        return reply.code(400).send({ error: '至少要保留一个启用的超级管理员' });
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
      detail: `删除用户「${target.username}」`,
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
      since: parsed.data.since,
    });
    return { logs: result.rows, total: result.total };
  });
}