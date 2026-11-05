import { randomUUID } from 'node:crypto';
import type { SqlDriver } from '../db/driver.js';

/** 一条 AI 对话在执行过程中产生的工具步骤。 */
export interface AiHistoryStep {
  name: string;
  args: Record<string, unknown>;
  detail?: string;
  ok?: boolean;
}

export interface AiHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps: AiHistoryStep[];
  createdAt: number;
}

export interface AppendAiMessageInput {
  deviceId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: AiHistoryStep[];
}

const MAX_MESSAGES = 100;

/** 每个用户每台设备保留最近 100 条，避免对话无限增长。 */
export class AiChatStore {
  constructor(private readonly db: SqlDriver) {}

  async list(
    deviceId: string,
    userId: string,
    limit = MAX_MESSAGES,
  ): Promise<AiHistoryMessage[]> {
    const rows = await this.db.query<{
      id: string;
      role: string;
      content: string;
      stepsJson: string | null;
      createdAt: number;
    }>(
      `SELECT id, role, content, steps_json AS stepsJson, created_at AS createdAt
       FROM adh_ai_messages
       WHERE device_id = ? AND user_id = ?
       ORDER BY created_at DESC
       LIMIT ${Math.min(MAX_MESSAGES, Math.max(1, limit))}`,
      [deviceId, userId],
    );

    return rows.reverse().map((row) => ({
      id: row.id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
      steps: parseSteps(row.stepsJson),
      createdAt: Number(row.createdAt) || 0,
    }));
  }

  async append(input: AppendAiMessageInput): Promise<AiHistoryMessage> {
    const message: AiHistoryMessage = {
      id: randomUUID(),
      role: input.role,
      content: input.content.slice(0, 20_000),
      steps: input.steps ?? [],
      createdAt: Date.now(),
    };

    await this.db.execute(
      `INSERT INTO adh_ai_messages
        (id, device_id, user_id, role, content, steps_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        input.deviceId,
        input.userId,
        message.role,
        message.content,
        JSON.stringify(message.steps),
        message.createdAt,
      ],
    );

    await this.trim(input.deviceId, input.userId);
    return message;
  }

  async clear(deviceId: string, userId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM adh_ai_messages WHERE device_id = ? AND user_id = ?',
      [deviceId, userId],
    );
  }

  /** 删除单条；device_id + user_id 一起限定，避免删到别人的记录。 */
  async remove(
    deviceId: string,
    userId: string,
    messageId: string,
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM adh_ai_messages
       WHERE id = ? AND device_id = ? AND user_id = ?`,
      [messageId, deviceId, userId],
    );
  }

  /** 只保留最近 MAX_MESSAGES 条，超出的逐条删除。 */
  private async trim(deviceId: string, userId: string): Promise<void> {
    const extra = await this.db.query<{ id: string }>(
      `SELECT id FROM adh_ai_messages
       WHERE device_id = ? AND user_id = ?
       ORDER BY created_at DESC
       LIMIT 100 OFFSET ${MAX_MESSAGES}`,
      [deviceId, userId],
    );
    for (const row of extra) {
      await this.db.execute('DELETE FROM adh_ai_messages WHERE id = ?', [
        row.id,
      ]);
    }
  }
}

function parseSteps(raw: string | null): AiHistoryStep[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is AiHistoryStep =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as { name?: unknown }).name === 'string',
      )
      .map((item) => ({
        name: item.name,
        args:
          item.args && typeof item.args === 'object'
            ? (item.args as Record<string, unknown>)
            : {},
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        ok: typeof item.ok === 'boolean' ? item.ok : undefined,
      }));
  } catch {
    return [];
  }
}