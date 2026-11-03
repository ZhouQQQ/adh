-- 设备操作日志：谁在什么时候对哪台设备做了什么

CREATE TABLE IF NOT EXISTS adh_device_logs (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  device_name TEXT,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS adh_device_logs_device_idx
  ON adh_device_logs (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adh_device_logs_created_idx
  ON adh_device_logs (created_at DESC);