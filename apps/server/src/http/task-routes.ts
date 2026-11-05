import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TaskService } from '../tasks/service.js';

const CreateTaskBody = z.object({
  instruction: z.string().min(1).max(2_000),
  deviceId: z.string().max(64).optional(),
  platform: z.enum(['android', 'ios']).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  timeoutSec: z.number().int().min(30).max(1_800).optional(),
});

const BatchTaskItem = z.object({
  deviceId: z.string().min(1).max(64),
  instruction: z.string().min(1).max(2_000),
  timeoutSec: z.number().int().min(30).max(1_800).optional(),
});

const CreateBatchTaskBody = z
  .object({
    instruction: z.string().min(1).max(2_000).optional(),
    deviceIds: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    tasks: z.array(BatchTaskItem).min(1).max(20).optional(),
    mode: z.enum(['parallel', 'sequential']).optional(),
    timeoutSec: z.number().int().min(30).max(1_800).optional(),
  })
  .refine(
    (data) =>
      Boolean(data.tasks?.length) ||
      Boolean(data.instruction && data.deviceIds?.length),
    { message: '需要提供 tasks，或 instruction + deviceIds' },
  );

const PlanBatchBody = z.object({
  instruction: z.string().min(1).max(2_000),
  deviceIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});

export interface TaskRouteDeps {
  tasks: TaskService;
}

export function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRouteDeps,
): void {
  /** 创建异步任务，立刻返回 taskId 供客户端轮询。 */
  app.post('/api/tasks', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });

    const parsed = CreateTaskBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '任务参数不合法' });
    }

    try {
      const task = await deps.tasks.create(user, parsed.data);
      return reply.code(202).send({ task });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : '创建任务失败' });
    }
  });

  /** 让 AI 根据一句自然语言判断单台还是多台，并拆出每台设备的任务。 */
  app.post('/api/tasks/batch/plan', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });

    const parsed = PlanBatchBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '任务编排参数不合法' });
    }

    try {
      const plan = await deps.tasks.planBatch(parsed.data);
      return { plan };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'AI 任务编排失败' });
    }
  });

  /**
   * 批量任务：同一指令下发到多台设备（parallel），或按设备分别指定指令
   * 并按顺序执行（sequential，适合有前后依赖的联动任务）。
   */
  app.post('/api/tasks/batch', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });

    const parsed = CreateBatchTaskBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '批量任务参数不合法' });
    }
    const data = parsed.data;
    const inputs =
      data.tasks ??
      data.deviceIds!.map((deviceId) => ({
        deviceId,
        instruction: data.instruction!,
        timeoutSec: data.timeoutSec,
      }));

    try {
      const tasks = await deps.tasks.createBatch(
        user,
        inputs,
        data.mode ?? 'parallel',
      );
      return reply.code(202).send({ tasks });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : '创建批量任务失败' });
    }
  });

  app.get('/api/tasks', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const query = request.query as { limit?: string } | undefined;
    const parsed = Number(query?.limit);
    const limit = Number.isFinite(parsed) ? parsed : 20;
    return { tasks: await deps.tasks.list(user.id, limit) };
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    const task = await deps.tasks.get(user.id, id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    return { task };
  });

  app.post('/api/tasks/:id/cancel', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    const task = await deps.tasks.get(user.id, id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    if (task.status !== 'queued' && task.status !== 'running') {
      return reply.code(409).send({ error: '任务已经结束' });
    }
    await deps.tasks.cancel(user.id, id);
    return { ok: true };
  });
}