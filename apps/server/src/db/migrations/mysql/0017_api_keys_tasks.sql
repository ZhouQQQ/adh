-- 外部 API Key 与异步 AI 任务

CREATE TABLE IF NOT EXISTS adh_api_keys (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(191) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  prefix VARCHAR(32) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY adh_api_keys_token_uq (token_hash),
  KEY adh_api_keys_user_idx (user_id),
  CONSTRAINT adh_api_keys_user_fk
    FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adh_tasks (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NULL,
  instruction TEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  reply MEDIUMTEXT NULL,
  steps_json MEDIUMTEXT NULL,
  error TEXT NULL,
  created_at BIGINT NOT NULL,
  started_at BIGINT NOT NULL DEFAULT 0,
  finished_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY adh_tasks_user_idx (user_id, created_at),
  CONSTRAINT adh_tasks_user_fk
    FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE,
  CONSTRAINT adh_tasks_device_fk
    FOREIGN KEY (device_id) REFERENCES adh_devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;