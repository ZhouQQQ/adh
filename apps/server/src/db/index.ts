import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import type { MysqlConfig } from '../config.js';
import * as schema from './schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

export type Db = MySql2Database<typeof schema>;

export interface DatabaseHandle {
  pool: Pool;
  db: Db;
  close(): Promise<void>;
}

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS adh_migrations (
    name VARCHAR(191) NOT NULL,
    applied_at BIGINT NOT NULL,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/** 按文件名顺序执行 migrations 目录下的 .sql，已执行的记在 adh_migrations。 */
async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(MIGRATIONS_TABLE);

  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT name FROM adh_migrations',
  );
  const applied = new Set(rows.map((row) => String(row.name)));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const connection = await pool.getConnection();
    try {
      await connection.query(sql);
      await connection.query(
        'INSERT INTO adh_migrations (name, applied_at) VALUES (?, ?)',
        [file, Date.now()],
      );
      console.log(`[db] migration applied: ${file}`);
    } finally {
      connection.release();
    }
  }
}

export async function openDatabase(config: MysqlConfig): Promise<DatabaseHandle> {
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

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw error;
  }

  await runMigrations(pool);

  return {
    pool,
    db: drizzle(pool, { schema, mode: 'default' }),
    close: () => pool.end(),
  };
}