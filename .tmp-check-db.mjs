import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('.data/adh.sqlite');
const columns = db.prepare('PRAGMA table_info(adh_agents)').all();
console.log(
  'columns:',
  columns.map((row) => row.name).join(', '),
);
const migrations = db
  .prepare('SELECT name FROM adh_migrations ORDER BY name DESC LIMIT 5')
  .all();
console.log('migrations:', migrations.map((row) => row.name).join(', '));
const row = db
  .prepare("SELECT id, tunnel_status FROM adh_agents WHERE id = 'builtin-local'")
  .get();
console.log('builtin tunnel_status:', row);