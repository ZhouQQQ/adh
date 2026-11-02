import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Pool } from 'mysql2/promise';

export type Dialect = 'sqlite' | 'mysql';

/**
 * 数据库的最小抽象：只保留 ? 占位符的查询 / 执行 / 多语句 DDL。
 * SQL 本身由上层按方言拼接（差异只有 INSERT IGNORE / upsert）。
 */
export interface SqlDriver {
  readonly dialect: Dialect;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** 执行多语句脚本（迁移用）。 */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export class SqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: DatabaseSync) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db
      .prepare(sql)
      .all(...(params as SQLInputValue[])) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as SQLInputValue[]));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class MysqlDriver implements SqlDriver {
  readonly dialect = 'mysql' as const;

  constructor(private readonly pool: Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}