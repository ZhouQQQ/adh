-- ADH 初始化（SQLite）
-- 时间戳统一存毫秒：INTEGER；JSON 字段直接存 TEXT

CREATE TABLE IF NOT EXISTS adh_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_name TEXT,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  token TEXT NOT NULL UNIQUE,
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adh_devices (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  udid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  market_name TEXT,
  brand TEXT,
  os_version TEXT,
  sdk INTEGER,
  cpu TEXT,
  cpu_vendor TEXT,
  cpu_model TEXT,
  cpu_cores INTEGER,
  memory_mb INTEGER,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  capabilities TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  last_seen INTEGER NOT NULL DEFAULT 0,
  thumbnail_at INTEGER NOT NULL DEFAULT 0,
  thumbnail_source TEXT NOT NULL DEFAULT 'auto',
  published_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES adh_agents (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS adh_devices_agent_udid_idx
  ON adh_devices (agent_id, udid);
CREATE INDEX IF NOT EXISTS adh_devices_agent_id_idx
  ON adh_devices (agent_id);

CREATE TABLE IF NOT EXISTS adh_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'apk',
  size INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS adh_packages_uploaded_at_idx
  ON adh_packages (uploaded_at);