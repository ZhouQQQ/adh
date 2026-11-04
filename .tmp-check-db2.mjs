import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('.data/adh.sqlite', { readOnly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all();
console.log('tables:', tables.map((row) => row.name).join(', '));
const pkg = db.prepare('PRAGMA table_info(adh_packages)').all();
console.log('packages columns:', pkg.map((row) => row.name).join(', '));
const users = db.prepare('PRAGMA table_info(adh_users)').all();
console.log('users columns:', users.map((row) => row.name).join(', '));