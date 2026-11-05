import type { FastifyInstance } from 'fastify';
import type { CommandBus } from '../command-bus.js';
import type { Queries } from '../db/queries.js';
import type { DeviceLogService } from '../logs/device-logs.js';
import type { Logger } from '../log.js';
import type { SettingsService } from '../settings/service.js';
import type { StreamManager } from '../stream/manager.js';
import { runAiChat } from '../ai/service.js';
import { AiChatStore, type AiHistoryStep } from '../ai/history.js';
import type { AiChatMessage, AiEvent } from '../ai/types.js';

export interface AiRouteDeps {
  queries: Queries;
  streams: StreamManager;
  commands: CommandBus;
  settings: SettingsService;
  deviceLogs: DeviceLogService;
  history: AiChatStore;
  logger: Logger;
}

/** 每个用户在同一台设备上只允许一个 AI 任务，key 是 deviceId:userId。 */
interface ActiveRun {
  abort: AbortController;
}

function parseMessages(value: unknown): AiChatMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: AiChatMessage[] = [];
  for (const item of value.slice(-20)) {
    if (!item || typeof item !== 'object') return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string') return null;
    messages.push({ role, content: content.slice(0, 4_000) });
  }
  return messages;
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const activeRuns = new Map<string, ActiveRun>();

  /** 只告诉前端是否可用，不暴露模型配置。 */
  app.get('/api/ai/status', async () => {
    const ai = await deps.settings.getAiSettings();
    return {
      enabled: ai.enabled && Boolean(ai.apiKey) && Boolean(ai.model),
    };
  });

  /** 当前用户在这台设备上的 AI 对话历史。 */
  app.get('/api/devices/:id/ai/messages', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    return { messages: await deps.history.list(id, user.id) };
  });

  app.delete('/api/devices/:id/ai/messages', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    await deps.history.clear(id, user.id);
    return { ok: true };
  });

  /** 删除单条；只允许删自己的记录。 */
  app.delete(
    '/api/devices/:id/ai/messages/:messageId',
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: '未登录' });
      const { id, messageId } = request.params as {
        id: string;
        messageId: string;
      };
      await deps.history.remove(id, user.id, messageId);
      return { ok: true };
    },
  );

  app.post('/api/devices/:id/ai/chat', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });

    const { id } = request.params as { id: string };
    const device = await deps.queries.getDevice(id);
    if (!device) return reply.code(404).send({ error: '设备不存在' });
    if (device.status !== 'online') {
      return reply.code(400).send({ error: '设备不在线' });
    }
    if (device.locked) {
      return reply.code(400).send({ error: '设备已被管理员锁定' });
    }

    // 只有当前持有控制权的人能用 AI，观看者和管理员未接管时都不行
    const control = deps.streams.getControl(id);
    if (!control || control.userId !== user.id) {
      return reply
        .code(403)
        .send({ error: '只有当前设备的控制者可以使用 AI 助手' });
    }

    const ai = await deps.settings.getAiSettings();
    if (!ai.enabled) {
      return reply.code(400).send({ error: 'AI 助手未启用' });
    }
    if (!ai.apiKey || !ai.model) {
      return reply.code(400).send({ error: 'AI 模型尚未配置' });
    }

    const body = (request.body ?? {}) as {
      message?: unknown;
      messages?: unknown;
    };
    let text = typeof body.message === 'string' ? body.message.trim() : '';
    if (!text) {
      // 兼容旧前端：从完整消息列表里取最后一条用户消息
      const legacy = parseMessages(body.messages);
      text =
        [...(legacy ?? [])]
          .reverse()
          .find((item) => item.role === 'user')
          ?.content.trim() ?? '';
    }
    if (!text) return reply.code(400).send({ error: '缺少用户消息' });

    const key = `${id}:${user.id}`;
    if (activeRuns.has(key)) {
      return reply.code(409).send({ error: '已有 AI 任务正在执行' });
    }

    // 历史从数据库读，前端刷新后由 /ai/messages 恢复
    const history = await deps.history.list(id, user.id, 10);
    const messages: AiChatMessage[] = [
      ...history.map((item) => ({ role: item.role, content: item.content })),
      { role: 'user', content: text },
    ];
    const userMessage = await deps.history.append({
      deviceId: id,
      userId: user.id,
      role: 'user',
      content: text,
    });

    const abort = new AbortController();
    activeRuns.set(key, { abort });

    void deps.deviceLogs.write({
      deviceId: device.id,
      deviceName: device.name,
      userId: user.id,
      username: user.username,
      action: 'ai.task.start',
      detail: text.slice(0, 200),
      ip: request.ip,
    });

    // SSE：模型调用和设备动作可能持续几十秒，逐条把进度推给前端
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.flushHeaders?.();

    let closed = false;
    let replyText = '';
    const steps: AiHistoryStep[] = [];
    const send = (event: AiEvent): void => {
      // 记录本轮执行步骤和最终回复，供刷新后恢复
      if (event.type === 'tool') {
        steps.push({ name: event.name, args: event.args });
      } else if (event.type === 'tool_result') {
        const last = steps[steps.length - 1];
        if (last && last.name === event.name && last.detail === undefined) {
          last.detail = event.detail;
          last.ok = event.ok;
        }
      } else if (event.type === 'reply') {
        replyText = event.content;
      }

      if (closed || raw.writableEnded) return;
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const onClose = (): void => {
      abort.abort();
    };
    request.raw.on('close', onClose);

    // 前端用它给刚落库的用户消息绑定 id，删除单条时才有主键
    send({ type: 'saved', role: 'user', id: userMessage.id });

    let completed = false;
    let failure = '';
    try {
      await runAiChat(
        {
          settings: deps.settings,
          streams: deps.streams,
          commands: deps.commands,
          logger: deps.logger,
        },
        {
          device,
          messages,
          signal: abort.signal,
          onEvent: send,
        },
      );
      completed = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (!abort.signal.aborted) {
        deps.logger.warn({ deviceId: id, err: failure }, 'ai chat failed');
        send({ type: 'error', message: failure });
      }
    } finally {
      activeRuns.delete(key);
      request.raw.off('close', onClose);

      const assistantText = completed
        ? replyText || '已完成'
        : abort.signal.aborted
          ? '用户已取消'
          : `任务执行失败：${failure || '未知错误'}`;

      // 取消时 runAiChat 不会发 reply，这里补一条，前端才能把
      // 「用户已取消」作为 assistant 消息保留；正常完成不能重复发。
      if (!completed && abort.signal.aborted) {
        send({ type: 'reply', content: assistantText });
        send({ type: 'done' });
      }

      let assistantId = '';
      try {
        const saved = await deps.history.append({
          deviceId: id,
          userId: user.id,
          role: 'assistant',
          content: assistantText,
          steps,
        });
        assistantId = saved.id;
      } catch (error) {
        deps.logger.warn(
          { deviceId: id, err: String(error) },
          'save ai history failed',
        );
      }

      if (!raw.writableEnded) {
        if (assistantId) {
          raw.write(
            `event: saved\ndata: ${JSON.stringify({
              type: 'saved',
              role: 'assistant',
              id: assistantId,
            })}\n\n`,
          );
        }
        raw.end();
      }
      closed = true;

      void deps.deviceLogs.write({
        deviceId: device.id,
        deviceName: device.name,
        userId: user.id,
        username: user.username,
        action: 'ai.task.end',
        detail: completed ? '已完成' : abort.signal.aborted ? '已取消' : '失败',
        ip: request.ip,
      });
    }
  });

  app.post('/api/devices/:id/ai/cancel', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录' });
    const { id } = request.params as { id: string };
    const run = activeRuns.get(`${id}:${user.id}`);
    if (run) {
      run.abort.abort();
      activeRuns.delete(`${id}:${user.id}`);
    }
    return { ok: true };
  });
}