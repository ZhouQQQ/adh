import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDriver } from '../db/driver.js';
import type { AuthUser } from './service.js';

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  enabled: number;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  /** 明文 Key，用于回显给用户本人。 */
  tokenPlain?: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    enabled: Boolean(row.enabled),
    createdAt: Number(row.createdAt) || 0,
    lastUsedAt: Number(row.lastUsedAt) || 0,
    expiresAt: Number(row.expiresAt) || 0,
  };
}

/** 给外部 agent / MCP 使用的长期 API Key，前缀 adhk_。 */
export class ApiKeyService {
  /** 同一用户并发首次访问时只创建一把 Key。 */
  private readonly ensuring = new Map<
    string,
    Promise<{ key: string; record: ApiKeyRecord }>
  >();

  constructor(private readonly db: SqlDriver) {}

  async list(userId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db.query<ApiKeyRow>(
      `SELECT id, name, prefix, enabled, created_at AS createdAt,
              last_used_at AS lastUsedAt, expires_at AS expiresAt,
              token_plain AS tokenPlain
       FROM adh_api_keys
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toRecord);
  }

  /** 创建 Key 并把明文一并存下来，方便 MCP 配置页随时回显。 */
  async create(
    userId: string,
    name: string,
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    const key = `adhk_${randomBytes(24).toString('hex')}`;
    const now = Date.now();
    const id = randomUUID();
    const prefix = key.slice(0, 12);

    await this.db.execute(
      `INSERT INTO adh_api_keys
        (id, user_id, name, token_hash, token_plain, prefix, enabled, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, 0)`,
      [id, userId, name.trim() || 'default', hashToken(key), key, prefix, now],
    );

    return {
      key,
      record: {
        id,
        name: name.trim() || 'default',
        prefix,
        enabled: true,
        createdAt: now,
        lastUsedAt: 0,
        expiresAt: 0,
      },
    };
  }

  /**
   * 取当前用户的默认 Key，没有就建一把。
   *
   * 明文随 Key 一起存下来，所以这里总能返回可直接复制的 key。
   */
  async ensureForUser(
    userId: string,
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    const pending = this.ensuring.get(userId);
    if (pending) return pending;

    const task = this.ensureForUserInner(userId).finally(() => {
      this.ensuring.delete(userId);
    });
    this.ensuring.set(userId, task);
    return task;
  }

  private async ensureForUserInner(
    userId: string,
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    const [row] = await this.db.query<ApiKeyRow>(
      `SELECT id, name, prefix, enabled, created_at AS createdAt,
              last_used_at AS lastUsedAt, expires_at AS expiresAt,
              token_plain AS tokenPlain
       FROM adh_api_keys
       WHERE user_id = ? AND enabled = 1
         AND (expires_at = 0 OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, Date.now()],
    );
    if (row?.tokenPlain) {
      return { key: row.tokenPlain, record: toRecord(row) };
    }
    // 没有 Key（或记录里没有明文）时直接重建一把，保证每个用户都有一把可用的
    return this.reset(userId);
  }

  /** 启动时给每个用户准备一把默认 Key，并清掉历史重复行。 */
  async ensureAllUsers(): Promise<number> {
    const users = await this.db.query<{ id: string }>(
      'SELECT id FROM adh_users',
    );
    let prepared = 0;
    for (const user of users) {
      const rows = await this.db.query<{ id: string; tokenPlain: string | null }>(
        `SELECT id, token_plain AS tokenPlain
         FROM adh_api_keys
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        [user.id],
      );
      // 一人只有一把 Key，多出来的（并发重复创建）删掉，保留最新的一条
      for (const extra of rows.slice(1)) {
        await this.db.execute(
          'DELETE FROM adh_api_keys WHERE id = ? AND user_id = ?',
          [extra.id, user.id],
        );
      }
      if (rows[0]?.tokenPlain) continue;
      await this.ensureForUser(user.id);
      prepared += 1;
    }
    return prepared;
  }

  /** 删除该用户全部 Key 并新建一把。 */
  async reset(
    userId: string,
    name = 'default',
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    await this.db.execute('DELETE FROM adh_api_keys WHERE user_id = ?', [
      userId,
    ]);
    return this.create(userId, name);
  }

  async remove(id: string, userId?: string): Promise<void> {
    if (userId) {
      await this.db.execute(
        'DELETE FROM adh_api_keys WHERE id = ? AND user_id = ?',
        [id, userId],
      );
      return;
    }
    await this.db.execute('DELETE FROM adh_api_keys WHERE id = ?', [id]);
  }

  /** 校验 Bearer token，返回对应的用户身份。 */
  async resolve(token: string): Promise<AuthUser | null> {
    if (!token.startsWith('adhk_')) return null;
    const [row] = await this.db.query<{
      id: string;
      userId: string;
      username: string;
      role: string;
      displayName: string | null;
      enabled: number;
      expiresAt: number;
    }>(
      `SELECT k.id, k.user_id AS userId, u.username, u.role,
              u.display_name AS displayName, k.enabled,
              k.expires_at AS expiresAt
       FROM adh_api_keys k
       JOIN adh_users u ON u.id = k.user_id
       WHERE k.token_hash = ?`,
      [hashToken(token)],
    );
    if (!row) return null;
    if (!row.enabled) return null;
    if (row.expiresAt > 0 && row.expiresAt < Date.now()) return null;

    await this.db.execute(
      'UPDATE adh_api_keys SET last_used_at = ? WHERE id = ?',
      [Date.now(), row.id],
    );

    return {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      role: row.role as AuthUser['role'],
    };
  }
}