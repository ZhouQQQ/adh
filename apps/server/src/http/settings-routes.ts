import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sharp from 'sharp';
import type { SettingsService } from '../settings/service.js';

interface SettingsRouteDeps {
  settings: SettingsService;
}

const UpdateSiteBody = z.object({
  title: z.string().max(40),
  subtitle: z.string().max(60).optional(),
  /** 普通用户同时控制设备上限，0 表示不限。 */
  operatorDeviceLimit: z.number().int().min(0).max(50).optional(),
  /** 管理员同时控制设备上限，0 表示不限。 */
  adminDeviceLimit: z.number().int().min(0).max(50).optional(),
});

/** 站点设置：标题与 Logo。读取公开（登录页也要用），写入仅管理员。 */
export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRouteDeps,
): Promise<void> {
  app.get('/api/settings', async () => deps.settings.getSite());

  app.get('/api/settings/logo', async (request, reply) => {
    const png = deps.settings.readLogo();
    if (!png) return reply.code(404).send({ error: '没有上传 Logo' });
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=60')
      .send(png);
  });

  app.put('/api/settings', async (request, reply) => {
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const parsed = UpdateSiteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '标题不能超过 40 个字' });
    }
    const current = await deps.settings.getSite();
    return deps.settings.saveSite({
      title: parsed.data.title,
      subtitle: parsed.data.subtitle ?? current.subtitle,
      operatorDeviceLimit: parsed.data.operatorDeviceLimit,
      adminDeviceLimit: parsed.data.adminDeviceLimit,
    });
  });

  app.post('/api/settings/logo', async (request, reply) => {
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: '图片内容为空' });
    }
    if (body.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ error: '图片超过 5MB' });
    }

    try {
      const png = await sharp(body)
        .resize(256, 256, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      const logoUpdatedAt = await deps.settings.saveLogo(png);
      return { logoUpdatedAt };
    } catch {
      return reply.code(400).send({ error: '无法识别图片格式' });
    }
  });

  app.delete('/api/settings/logo', async (request, reply) => {
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    await deps.settings.removeLogo();
    return { logoUpdatedAt: 0 };
  });
}