import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDriver } from './driver.js';
import { createQueries } from './queries.js';

const root = path.join(import.meta.dirname, 'migrations/sqlite');
const db = new DatabaseSync(':memory:');
for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(path.join(root, file), 'utf8'));
}
const queries = createQueries(new SqliteDriver(db));

db.exec(
  `INSERT INTO adh_agents (id,name,host_name,os,arch,version,capabilities,token,last_seen,created_at)
   VALUES ('a1','agent',NULL,'win','x64','1','[]','tok',0,0)`,
);

const info = {
  udid: 'u1',
  platform: 'android' as const,
  name: 'Pixel',
  status: 'online' as const,
  capabilities: [],
  tags: [],
};

const created = await queries.upsertDevice('a1', info);
console.log('created', { connectedAt: created.connectedAt, useCount: created.useCount, lastUsedAt: created.lastUsedAt });

await queries.incrementDeviceUsage(created.id);
const used = await queries.getDevice(created.id);
console.log('after use', { useCount: used?.useCount, lastUsedAt: used?.lastUsedAt });

await queries.markDeviceOffline('a1', 'u1');
await new Promise((r) => setTimeout(r, 20));
const back = await queries.upsertDevice('a1', info);
console.log('reconnect', { status: back.status, connectedAt: back.connectedAt, newerThanBefore: back.connectedAt > created.connectedAt });

const patched = await queries.patchDevice('a1', 'u1', { name: 'Pixel 9' });
console.log('patch name keeps connectedAt', patched?.connectedAt === back.connectedAt, patched?.useCount);

db.close();