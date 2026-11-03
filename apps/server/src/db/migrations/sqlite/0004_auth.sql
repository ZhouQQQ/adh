-- 用户、登录会话、审计日志

CREATE TABLE IF NOT EXISTS adh_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS adh_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS adh_sessions_user_idx ON adh_sessions (user_id);

CREATE TABLE IF NOT EXISTS adh_audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT,
  role TEXT,
  action TEXT NOT NULL,
  target TEXT,
  method TEXT,
  path TEXT,
  status INTEGER,
  ip TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS adh_audit_logs_created_idx
  ON adh_audit_logs (created_at DESC);