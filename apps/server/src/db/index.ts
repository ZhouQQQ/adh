import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import type { DatabaseConfig } from '../config.js';
import { MysqlDriver, SqliteDriver, type Dialect, type SqlDriver } from './driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = path.join(HERE, 'migrations');

export interface DatabaseHandle {
  driver: SqlDriver;
  close(): Promise<void>;
}

const MIGRATIONS_TABLE: Record<Dialect, string> = {
  sqlite: `
    CREATE TABLE IF NOT EXISTS adh_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `,
  mysql: `
    CREATE TABLE IF NOT EXISTS adh_migrations (
      name VARCHAR(191) NOT NULL,
      applied_at BIGINT NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `,
};

/** 按文件名顺序执行 migrations/<dialect>/*.sql，已执行的记在 adh_migrations。 */
async function runMigrations(driver: SqlDriver): Promise<void> {
  await driver.exec(MIGRATIONS_TABLE[driver.dialect]);

  const rows = await driver.query<{ name: string }>(
    'SELECT name FROM adh_migrations',
  );
  const applied = new Set(rows.map((row) => row.name));

  const dir = path.join(MIGRATIONS_ROOT, driver.dialect);
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await driver.exec(sql);
    await driver.execute(
      'INSERT INTO adh_migrations (name, applied_at) VALUES (?, ?)',
      [file, Date.now()],
    );
    console.log(`[db] migration applied: ${file}`);
  }
}

export async function openDatabase(
  config: DatabaseConfig,
): Promise<DatabaseHandle> {
  if (config.kind === 'mysql') {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10,
      idleTimeout: 60_000,
      enableKeepAlive: true,
      // 迁移文件里有多条语句
      multipleStatements: true,
    });

    const driver = new MysqlDriver(pool);
    try {
      await pool.query('SELECT 1');
      await runMigrations(driver);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return { driver, close: () => driver.close() };
  }

  fs.mkdirSync(path.dirname(config.path), { recursive: true });
  const db = new DatabaseSync(config.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const driver = new SqliteDriver(db);
  await runMigrations(driver);
  return { driver, close: () => driver.close() };
}