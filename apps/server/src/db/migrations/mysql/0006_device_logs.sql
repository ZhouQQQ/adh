-- 设备操作日志：谁在什么时候对哪台设备做了什么

CREATE TABLE IF NOT EXISTS adh_device_logs (
  id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NULL,
  device_name VARCHAR(191) NULL,
  user_id VARCHAR(64) NULL,
  username VARCHAR(64) NULL,
  action VARCHAR(32) NOT NULL,
  detail VARCHAR(500) NULL,
  ip VARCHAR(64) NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY adh_device_logs_device_idx (device_id, created_at),
  KEY adh_device_logs_created_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;