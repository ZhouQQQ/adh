-- 系统设置：站点标题、Logo 等键值配置
CREATE TABLE IF NOT EXISTS adh_settings (
  name VARCHAR(64) NOT NULL,
  value TEXT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;