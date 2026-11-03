-- 系统设置：站点标题、Logo 等键值配置
CREATE TABLE IF NOT EXISTS adh_settings (
  name TEXT NOT NULL PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);