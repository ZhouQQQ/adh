import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceLogService } from '../logs/device-logs.js';

interface DeviceLogRouteDeps {
  deviceLogs: DeviceLogService;
}

const LogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  deviceId: z.string().max(64).optional(),
  username: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  /** 起始时间（毫秒时间戳），用于快捷时间范围过滤。 */
  since: z.coerce.number().int().min(0).optional(),
});

export async function registerDeviceLogRoutes(
  app: FastifyInstance,
  deps: DeviceLogRouteDeps,
): Promise<void> {
  app.get('/api/device-logs', async (request, reply) => {
    const parsed = LogQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数不合法' });
    }

    const result = await deps.deviceLogs.list({
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
      deviceId: parsed.data.deviceId,
      username: parsed.data.username,
      action: parsed.data.action,
      since: parsed.data.since,
    });
    return { logs: result.logs, total: result.total };
  });
}