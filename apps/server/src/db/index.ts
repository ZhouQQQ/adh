import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: Db;
}

function runMigrations(sqlite: Database.Database): void {
  // 迁移记录表同样以 adh_ 开头，老库的 _migrations 需要搬过来
  const legacy = sqlite
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_migrations'",
    )
    .get();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS adh_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  if (legacy) {
    sqlite.exec(`
      INSERT OR IGNORE INTO adh_migrations (name, applied_at)
        SELECT name, applied_at FROM _migrations;
      DROP TABLE _migrations;
    `);
  }

  const applied = new Set(
    (
      sqlite.prepare('SELECT name FROM adh_migrations').all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO adh_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
    })();
  }
}

export function openDatabase(dbPath: string): DatabaseHandle {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}