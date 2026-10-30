CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  token TEXT NOT NULL UNIQUE,
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  udid TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  os_version TEXT,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  capabilities TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  last_seen INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_agent_udid_idx ON devices(agent_id, udid);
CREATE INDEX IF NOT EXISTS devices_agent_id_idx ON devices(agent_id);