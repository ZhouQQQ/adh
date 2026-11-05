import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sharp from 'sharp';
import {
  MAX_IDLE_TIMEOUT_MINUTES,
  type SettingsService,
} from '../settings/service.js';

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
  /** 超级管理员同时控制设备上限，0 表示不限。 */
  superadminDeviceLimit: z.number().int().min(0).max(50).optional(),
  /** 控制者无操作自动断开的分钟数，0 表示不自动断开。 */
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(0)
    .max(MAX_IDLE_TIMEOUT_MINUTES)
    .optional(),
});

const UpdateAiBody = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().max(500).optional(),
  /** 留空表示不修改；带 **** 的是前端回显的打码值，同样忽略。 */
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  systemPrompt: z.string().max(8000).optional(),
});

/** 只暴露首尾几位，避免把完整 key 返回给浏览器。 */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

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
    if (request.user?.role !== 'superadmin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const parsed = UpdateSiteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '设置参数不合法' });
    }
    const current = await deps.settings.getSite();
    return deps.settings.saveSite({
      title: parsed.data.title,
      subtitle: parsed.data.subtitle ?? current.subtitle,
      operatorDeviceLimit: parsed.data.operatorDeviceLimit,
      adminDeviceLimit: parsed.data.adminDeviceLimit,
      superadminDeviceLimit: parsed.data.superadminDeviceLimit,
      idleTimeoutMinutes: parsed.data.idleTimeoutMinutes,
    });
  });

  app.post('/api/settings/logo', async (request, reply) => {
    if (request.user?.role !== 'superadmin') {
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
    if (request.user?.role !== 'superadmin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    await deps.settings.removeLogo();
    return { logoUpdatedAt: 0 };
  });

  /** AI 助手配置：只给超级管理员，apiKey 打码返回。 */
  app.get('/api/settings/ai', async (request, reply) => {
    if (request.user?.role !== 'superadmin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const settings = await deps.settings.getAiSettings();
    return {
      ...settings,
      apiKey: maskApiKey(settings.apiKey),
      hasApiKey: Boolean(settings.apiKey),
    };
  });

  app.put('/api/settings/ai', async (request, reply) => {
    if (request.user?.role !== 'superadmin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const parsed = UpdateAiBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'AI 设置参数不合法' });
    }
    const input = { ...parsed.data };
    // 空值表示不修改，打码值也不能回写，避免把 **** 存成真正的 key
    if (!input.apiKey || !input.apiKey.trim() || input.apiKey.includes('****')) {
      delete input.apiKey;
    }
    const saved = await deps.settings.saveAiSettings(input);
    return {
      ...saved,
      apiKey: maskApiKey(saved.apiKey),
      hasApiKey: Boolean(saved.apiKey),
    };
  });
}