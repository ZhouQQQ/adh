import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDriver } from '../db/driver.js';
import { hashPassword, verifyPassword } from './password.js';

export const ROLES = ['superadmin', 'admin', 'operator'] as const;
export type Role = (typeof ROLES)[number];

/** 管理员与超级管理员都能做的操作。 */
export function isAdminRole(role: string): boolean {
  return role === 'admin' || role === 'superadmin';
}

/** 超级管理员专属（仪表盘、审计、节点、系统设置等）。 */
export function isSuperAdminRole(role: string): boolean {
  return role === 'superadmin';
}

export function roleLabel(role: string): string {
  if (role === 'superadmin') return '超级管理员';
  if (role === 'admin') return '管理员';
  return '普通用户';
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
}

export interface UserRow extends AuthUser {
  enabled: boolean;
  createdAt: number;
  lastLoginAt: number;
}

export interface AuditRow {
  id: string;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  role: string | null;
  action: string;
  target: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  ip: string | null;
  detail: string | null;
  createdAt: number;
}

export interface AuditInput {
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  action: string;
  target?: string | null;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  ip?: string | null;
  detail?: string | null;
}

interface UserQueryRow {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  displayName: string | null;
  enabled: number;
  createdAt: number;
  lastLoginAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toUser(row: { id: string; username: string; role: string; displayName: string | null }): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? null,
    role: row.role as Role,
  };
}

export class AuthService {
  constructor(private readonly db: SqlDriver) {}

  /** 首次启动创建默认超管 root / rootxiaoan。 */
  async ensureDefaultAdmin(): Promise<void> {
    const [row] = await this.db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM adh_users',
    );
    if (Number(row?.total ?? 0) === 0) {
      await this.createUser({
        username: 'admin',
        password: 'admin',
        role: 'superadmin',
        displayName: '超级管理员',
      });
      console.log('[auth] created default superadmin: admin');
      return;
    }

    // 旧库默认账号是 root，平滑改成 admin
    const root = await this.getByUsername('root');
    const admin = await this.getByUsername('admin');
    if (root && !admin) {
      await this.db.execute(
        `UPDATE adh_users
         SET username = 'admin', password_hash = ?, display_name = '超级管理员', role = 'superadmin'
         WHERE id = ?`,
        [hashPassword('admin'), root.id],
      );
      console.log('[auth] migrated default admin: root -> admin');
    }
  }

  async login(
    username: string,
    password: string,
    ip: string | null,
  ): Promise<{ token: string; user: AuthUser } | null> {
    const [row] = await this.db.query<UserQueryRow>(
      `SELECT id, username, password_hash AS passwordHash, role,
              display_name AS displayName, enabled,
              created_at AS createdAt, last_login_at AS lastLoginAt
       FROM adh_users WHERE username = ?`,
      [username],
    );

    if (!row || !Number(row.enabled) || !verifyPassword(password, row.passwordHash)) {
      await this.writeAudit({
        username,
        action: 'login.failed',
        status: 401,
        ip,
        detail: '用户名或密码错误',
      });
      return null;
    }

    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    // 单点登录：新登录直接作废旧会话，旧设备会被挤下线
    await this.db.execute('DELETE FROM adh_sessions WHERE user_id = ?', [row.id]);
    await this.db.execute(
      `INSERT INTO adh_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [tokenHash(token), row.id, now, now + SESSION_TTL_MS],
    );
    await this.db.execute('UPDATE adh_users SET last_login_at = ? WHERE id = ?', [
      now,
      row.id,
    ]);
    await this.writeAudit({
      userId: row.id,
      username: row.username,
      role: row.role,
      action: 'login',
      status: 200,
      ip,
      detail: '登录成功',
    });

    return { token, user: toUser(row) };
  }

  async resolveToken(token: string): Promise<AuthUser | null> {
    if (!token) return null;
    const hash = tokenHash(token);
    const [row] = await this.db.query<
      UserQueryRow & { expiresAt: number }
    >(
      `SELECT u.id, u.username, u.role, u.display_name AS displayName,
              u.enabled, s.expires_at AS expiresAt
       FROM adh_sessions s
       JOIN adh_users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      [hash],
    );

    if (!row) return null;
    if (Number(row.expiresAt) <= Date.now()) {
      await this.db.execute('DELETE FROM adh_sessions WHERE token_hash = ?', [hash]);
      return null;
    }
    if (!Number(row.enabled)) return null;
    return toUser(row);
  }

  async logout(token: string): Promise<void> {
    if (!token) return;
    const hash = tokenHash(token);
    const [row] = await this.db.query<{ userId: string; username: string; role: string }>(
      `SELECT s.user_id AS userId, u.username, u.role
       FROM adh_sessions s JOIN adh_users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      [hash],
    );
    await this.db.execute('DELETE FROM adh_sessions WHERE token_hash = ?', [hash]);
    if (row) {
      await this.writeAudit({
        userId: row.userId,
        username: row.username,
        role: row.role,
        action: 'logout',
        detail: '退出登录',
      });
    }
  }

  async listUsers(): Promise<UserRow[]> {
    const rows = await this.db.query<UserQueryRow>(
      `SELECT id, username, '' AS passwordHash, role,
              display_name AS displayName, enabled,
              created_at AS createdAt, last_login_at AS lastLoginAt
       FROM adh_users ORDER BY created_at ASC`,
    );
    return rows.map((row) => ({
      ...toUser(row),
      enabled: Boolean(Number(row.enabled)),
      createdAt: Number(row.createdAt),
      lastLoginAt: Number(row.lastLoginAt),
    }));
  }

  async getByUsername(username: string): Promise<UserRow | undefined> {
    const [row] = await this.db.query<UserQueryRow>(
      `SELECT id, username, '' AS passwordHash, role,
              display_name AS displayName, enabled,
              created_at AS createdAt, last_login_at AS lastLoginAt
       FROM adh_users WHERE username = ?`,
      [username],
    );
    if (!row) return undefined;
    return {
      ...toUser(row),
      enabled: Boolean(Number(row.enabled)),
      createdAt: Number(row.createdAt),
      lastLoginAt: Number(row.lastLoginAt),
    };
  }

  /** 校验原密码后修改自己的密码。 */
  async changePassword(
    id: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const [row] = await this.db.query<{ passwordHash: string }>(
      'SELECT password_hash AS passwordHash FROM adh_users WHERE id = ?',
      [id],
    );
    if (!row || !verifyPassword(oldPassword, row.passwordHash)) return false;

    await this.db.execute(
      'UPDATE adh_users SET password_hash = ? WHERE id = ?',
      [hashPassword(newPassword), id],
    );
    return true;
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.query<UserQueryRow>(
      `SELECT id, username, '' AS passwordHash, role,
              display_name AS displayName, enabled,
              created_at AS createdAt, last_login_at AS lastLoginAt
       FROM adh_users WHERE id = ?`,
      [id],
    );
    if (!row) return undefined;
    return {
      ...toUser(row),
      enabled: Boolean(Number(row.enabled)),
      createdAt: Number(row.createdAt),
      lastLoginAt: Number(row.lastLoginAt),
    };
  }

  async createUser(input: {
    username: string;
    password: string;
    role: Role;
    displayName?: string | null;
  }): Promise<UserRow> {
    const now = Date.now();
    const row: UserRow = {
      id: randomUUID(),
      username: input.username,
      displayName: input.displayName ?? null,
      role: input.role,
      enabled: true,
      createdAt: now,
      lastLoginAt: 0,
    };
    await this.db.execute(
      `INSERT INTO adh_users
        (id, username, password_hash, role, display_name, enabled, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.username,
        hashPassword(input.password),
        row.role,
        row.displayName,
        1,
        row.createdAt,
        row.lastLoginAt,
      ],
    );
    return row;
  }

  async updateUser(
    id: string,
    patch: {
      displayName?: string | null;
      role?: Role;
      enabled?: boolean;
      password?: string;
    },
  ): Promise<UserRow | undefined> {
    const existing = await this.getUser(id);
    if (!existing) return undefined;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(patch.displayName);
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.password !== undefined) {
      sets.push('password_hash = ?');
      params.push(hashPassword(patch.password));
    }

    if (sets.length > 0) {
      params.push(id);
      await this.db.execute(
        `UPDATE adh_users SET ${sets.join(', ')} WHERE id = ?`,
        params,
      );
      if (patch.password !== undefined) {
        // 改密码后让该用户的其它会话失效
        await this.db.execute('DELETE FROM adh_sessions WHERE user_id = ?', [id]);
      }
    }
    return this.getUser(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    const existing = await this.getUser(id);
    if (!existing) return false;
    await this.db.execute('DELETE FROM adh_users WHERE id = ?', [id]);
    return true;
  }

  async countSuperAdmins(): Promise<number> {
    const [row] = await this.db.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM adh_users WHERE role = 'superadmin' AND enabled = 1",
    );
    return Number(row?.total ?? 0);
  }

  async countAdmins(): Promise<number> {
    const [row] = await this.db.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM adh_users WHERE role IN ('admin','superadmin') AND enabled = 1",
    );
    return Number(row?.total ?? 0);
  }

  async listAudit(options: {
    limit: number;
    offset: number;
    username?: string;
    action?: string;
    role?: string;
    /** 只返回该时间之后的日志（毫秒时间戳）。 */
    since?: number;
    /** 只返回该时间之前的日志（毫秒时间戳）。 */
    until?: number;
  }): Promise<{ rows: AuditRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.since && options.since > 0) {
      where.push('l.created_at >= ?');
      params.push(options.since);
    }
    if (options.until && options.until > 0) {
      where.push('l.created_at <= ?');
      params.push(options.until);
    }
    if (options.role) {
      where.push('l.role = ?');
      params.push(options.role);
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
      `SELECT COUNT(*) AS total FROM adh_audit_logs l ${clause}`,
      params,
    );

    const rows = await this.db.query<AuditRow>(
      `SELECT l.id, l.user_id AS userId, l.username,
              u.display_name AS displayName,
              l.role, l.action, l.target, l.method, l.path, l.status, l.ip, l.detail,
              l.created_at AS createdAt
       FROM adh_audit_logs l
       LEFT JOIN adh_users u ON u.username = l.username
       ${clause}
       ORDER BY l.created_at DESC
       LIMIT ${Math.max(1, Math.min(200, options.limit))}
       OFFSET ${Math.max(0, options.offset)}`,
      params,
    );

    return {
      rows: rows.map((row) => ({
        ...row,
        createdAt: Number(row.createdAt),
      })),
      total: Number(count?.total ?? 0),
    };
  }

  async writeAudit(input: AuditInput): Promise<void> {
    try {
      await this.db.execute(
        `INSERT INTO adh_audit_logs
          (id, user_id, username, role, action, target, method, path, status, ip, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.userId ?? null,
          input.username ?? null,
          input.role ?? null,
          input.action,
          input.target ?? null,
          input.method ?? null,
          input.path ?? null,
          input.status ?? null,
          input.ip ?? null,
          input.detail ?? null,
          Date.now(),
        ],
      );
    } catch (error) {
      console.warn(
        `[audit] 写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}