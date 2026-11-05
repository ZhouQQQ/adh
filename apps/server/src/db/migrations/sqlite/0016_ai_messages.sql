-- AI 助手对话记录：按设备 + 用户隔离，刷新或换浏览器后可恢复
CREATE TABLE IF NOT EXISTS adh_ai_messages (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  steps_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES adh_devices (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS adh_ai_messages_lookup_idx
  ON adh_ai_messages (device_id, user_id, created_at);