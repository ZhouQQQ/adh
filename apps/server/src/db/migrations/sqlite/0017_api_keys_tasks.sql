-- 外部 API Key 与异步 AI 任务

CREATE TABLE IF NOT EXISTS adh_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS adh_api_keys_user_idx
  ON adh_api_keys (user_id);

CREATE TABLE IF NOT EXISTS adh_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  reply TEXT,
  steps_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES adh_devices (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS adh_tasks_user_idx
  ON adh_tasks (user_id, created_at);