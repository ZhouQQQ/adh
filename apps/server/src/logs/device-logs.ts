import { randomUUID } from 'node:crypto';
import type { SqlDriver } from '../db/driver.js';

export interface DeviceLogRow {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: number;
}

export interface DeviceLogInput {
  deviceId?: string | null;
  deviceName?: string | null;
  userId?: string | null;
  username?: string | null;
  action: string;
  detail?: string | null;
  ip?: string | null;
}

/** 设备操作日志：控制、按键、安装、文件操作等。 */
export class DeviceLogService {
  constructor(private readonly db: SqlDriver) {}

  async write(input: DeviceLogInput): Promise<void> {
    try {
      await this.db.execute(
        `INSERT INTO adh_device_logs
          (id, device_id, device_name, user_id, username, action, detail, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.deviceId ?? null,
          input.deviceName ?? null,
          input.userId ?? null,
          input.username ?? null,
          input.action,
          input.detail ?? null,
          input.ip ?? null,
          Date.now(),
        ],
      );
    } catch (error) {
      console.warn(
        `[device-log] 写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(options: {
    limit: number;
    offset: number;
    deviceId?: string;
    username?: string;
    action?: string;
    /** 只返回该时间之后的日志（毫秒时间戳）。 */
    since?: number;
  }): Promise<{ logs: DeviceLogRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.since && options.since > 0) {
      where.push('l.created_at >= ?');
      params.push(options.since);
    }
    if (options.deviceId) {
      where.push('l.device_id = ?');
      params.push(options.deviceId);
    }
    if (options.username) {
      where.push('l.username = ?');
      params.push(options.username);
    }
    if (options.action) {
      where.push('l.action = ?');
      params.push(options.action);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [count] = await this.db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM adh_device_logs l ${clause}`,
      params,
    );

    const logs = await this.db.query<DeviceLogRow>(
      `SELECT l.id, l.device_id AS deviceId, l.device_name AS deviceName,
              l.user_id AS userId, l.username,
              u.display_name AS displayName,
              l.action, l.detail, l.ip,
              l.created_at AS createdAt
       FROM adh_device_logs l
       LEFT JOIN adh_users u ON u.username = l.username
       ${clause}
       ORDER BY l.created_at DESC
       LIMIT ${Math.max(1, Math.min(200, options.limit))}
       OFFSET ${Math.max(0, options.offset)}`,
      params,
    );

    return {
      logs: logs.map((row) => ({ ...row, createdAt: Number(row.createdAt) })),
      total: Number(count?.total ?? 0),
    };
  }
}