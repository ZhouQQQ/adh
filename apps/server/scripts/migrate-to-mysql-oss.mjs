/**
 * 一次性迁移：SQLite(.data/adh.sqlite) → MySQL，并把本地文件同步到 OSS。
 *
 *   pnpm migrate:data
 *
 * 可重复执行：写入用 INSERT ... ON DUPLICATE KEY UPDATE，OSS 上传会覆盖同名对象。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import OSS from 'ali-oss';
import mysql from 'mysql2/promise';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

if (fs.existsSync(path.join(root, '.env'))) {
  process.loadEnvFile(path.join(root, '.env'));
}

const dataDir = path.join(root, '.data');
const sqlitePath = path.join(dataDir, 'adh.sqlite');
const migrationsDir = path.join(
  root,
  'apps',
  'server',
  'src',
  'db',
  'migrations',
  'mysql',
);

function env(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function main() {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`找不到 SQLite 文件：${sqlitePath}`);
  }

  const pool = mysql.createPool({
    host: env('MYSQL_HOST'),
    port: Number(env('MYSQL_PORT') ?? 3306),
    user: env('MYSQL_USER'),
    password: env('MYSQL_PASSWORD') ?? '',
    database: env('MYSQL_DB'),
    multipleStatements: true,
    connectionLimit: 5,
  });

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });

  try {
    await migrateSchema(pool);
    await migrateRows(sqlite, pool);
    await uploadToOss();
    console.log('\n迁移完成');
  } finally {
    sqlite.close();
    await pool.end();
  }
}

async function migrateSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS adh_migrations (
      name VARCHAR(191) NOT NULL,
      applied_at BIGINT NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query(
      'INSERT IGNORE INTO adh_migrations (name, applied_at) VALUES (?, ?)',
      [file, Date.now()],
    );
    console.log(`[db] schema ${file}`);
  }
}

function hasTable(sqlite, name) {
  const row = sqlite
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function readAll(sqlite, table) {
  if (!hasTable(sqlite, table)) return [];
  return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

async function migrateRows(sqlite, pool) {
  const agents = readAll(sqlite, 'adh_agents');
  for (const row of agents) {
    await pool.query(
      `INSERT INTO adh_agents
        (id, name, host_name, os, arch, version, capabilities, token, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), host_name = VALUES(host_name), os = VALUES(os),
         arch = VALUES(arch), version = VALUES(version),
         capabilities = VALUES(capabilities), token = VALUES(token),
         last_seen = VALUES(last_seen)`,
      [
        row.id,
        row.name,
        row.host_name ?? null,
        row.os,
        row.arch,
        row.version,
        row.capabilities,
        row.token,
        row.last_seen,
        row.created_at,
      ],
    );
  }
  console.log(`[db] agents   ${agents.length}`);

  const devices = readAll(sqlite, 'adh_devices');
  for (const row of devices) {
    await pool.query(
      `INSERT INTO adh_devices
        (id, agent_id, udid, platform, name, model, market_name, brand,
         os_version, sdk, cpu, cpu_vendor, cpu_model, cpu_cores, memory_mb,
         resolution, status, capabilities, tags, last_seen, thumbnail_at,
         thumbnail_source, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), model = VALUES(model), market_name = VALUES(market_name),
         brand = VALUES(brand), os_version = VALUES(os_version), sdk = VALUES(sdk),
         cpu = VALUES(cpu), cpu_vendor = VALUES(cpu_vendor), cpu_model = VALUES(cpu_model),
         cpu_cores = VALUES(cpu_cores), memory_mb = VALUES(memory_mb),
         resolution = VALUES(resolution), status = VALUES(status),
         capabilities = VALUES(capabilities), tags = VALUES(tags),
         last_seen = VALUES(last_seen), thumbnail_at = VALUES(thumbnail_at),
         thumbnail_source = VALUES(thumbnail_source), published_at = VALUES(published_at)`,
      [
        row.id,
        row.agent_id,
        row.udid,
        row.platform,
        row.name,
        row.model ?? null,
        row.market_name ?? null,
        row.brand ?? null,
        row.os_version ?? null,
        row.sdk ?? null,
        row.cpu ?? null,
        row.cpu_vendor ?? null,
        row.cpu_model ?? null,
        row.cpu_cores ?? null,
        row.memory_mb ?? null,
        row.resolution ?? null,
        row.status,
        row.capabilities,
        row.tags,
        row.last_seen,
        row.thumbnail_at ?? 0,
        row.thumbnail_source ?? 'auto',
        row.published_at ?? 0,
      ],
    );
  }
  console.log(`[db] devices  ${devices.length}`);

  const packages = readAll(sqlite, 'adh_packages');
  for (const row of packages) {
    await pool.query(
      `INSERT INTO adh_packages (id, name, kind, size, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), kind = VALUES(kind), size = VALUES(size),
         uploaded_at = VALUES(uploaded_at)`,
      [row.id, row.name, row.kind, row.size, row.uploaded_at],
    );
  }
  console.log(`[db] packages ${packages.length}`);
}

function createOssClient() {
  const bucket = env('ADH_OSS_BUCKET', 'OSS_BUCKET_NAME');
  const accessKeyId = env('ADH_OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID');
  const accessKeySecret = env('ADH_OSS_ACCESS_KEY_SECRET', 'OSS_ACCESS_KEY_SECRET');
  if (!bucket || !accessKeyId || !accessKeySecret) return null;

  const rawRegion = env('ADH_OSS_REGION', 'OSS_REGION_ID') ?? 'oss-cn-hangzhou';
  return {
    prefix: (env('ADH_OSS_PREFIX') ?? 'adh').replace(/^\/+|\/+$/g, ''),
    client: new OSS({
      region: rawRegion.startsWith('oss-') ? rawRegion : `oss-${rawRegion}`,
      endpoint: env('ADH_OSS_ENDPOINT', 'OSS_ENDPOINT'),
      bucket,
      accessKeyId,
      accessKeySecret,
      secure: true,
    }),
  };
}

function filesIn(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => pattern.test(file))
    .map((file) => path.join(dir, file));
}

async function uploadToOss() {
  const oss = createOssClient();
  if (!oss) {
    console.log('[oss] 未配置，跳过文件同步');
    return;
  }

  const groups = [
    {
      dir: path.join(dataDir, 'packages'),
      pattern: /^[a-f0-9]{64}\.(apk|ipa)$/,
      key: (file) => `${oss.prefix}/packages/${file}`,
      mime: (file) =>
        file.endsWith('.ipa')
          ? 'application/octet-stream'
          : 'application/vnd.android.package-archive',
    },
    {
      dir: path.join(dataDir, 'thumbnails'),
      pattern: /\.jpg$/,
      key: (file) => `${oss.prefix}/thumbnails/${file}`,
      mime: () => 'image/jpeg',
    },
    {
      dir: path.join(dataDir, 'app-icons'),
      pattern: /\.png$/,
      key: (file) => `${oss.prefix}/app-icons/${file}`,
      mime: () => 'image/png',
    },
  ];

  for (const group of groups) {
    const files = filesIn(group.dir, group.pattern);
    for (const file of files) {
      const name = path.basename(file);
      const data = fs.readFileSync(file);
      await oss.client.put(group.key(name), data, { mime: group.mime(name) });
      console.log(
        `[oss] ${group.key(name)}  ${(data.length / 1024 / 1024).toFixed(1)} MB`,
      );
    }
    if (files.length === 0) console.log(`[oss] ${group.dir} 为空`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});