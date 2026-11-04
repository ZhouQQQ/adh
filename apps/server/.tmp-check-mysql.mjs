import fs from 'node:fs';
import mysql from 'mysql2/promise';

const env = Object.fromEntries(
  fs
    .readFileSync('../../.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const conn = await mysql.createConnection({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT ?? 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DB,
});

const [columns] = await conn.query('SHOW COLUMNS FROM adh_agents');
console.log('adh_agents columns:', columns.map((row) => row.Field).join(', '));

const [migrations] = await conn.query(
  'SELECT name FROM adh_migrations ORDER BY name',
);
console.log('migrations:', migrations.map((row) => row.name).join(', '));

const [row] = await conn.query(
  "SELECT id, tunnel_status FROM adh_agents WHERE id = 'builtin-local'",
);
console.log('builtin tunnel:', row);

await conn.end();