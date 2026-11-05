-- AI 助手对话记录：按设备 + 用户隔离，刷新或换浏览器后可恢复
CREATE TABLE IF NOT EXISTS adh_ai_messages (
  id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  steps_json MEDIUMTEXT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY adh_ai_messages_lookup_idx (device_id, user_id, created_at),
  CONSTRAINT adh_ai_messages_device_fk
    FOREIGN KEY (device_id) REFERENCES adh_devices (id) ON DELETE CASCADE,
  CONSTRAINT adh_ai_messages_user_fk
    FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;