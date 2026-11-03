-- 用户、登录会话、审计日志

CREATE TABLE IF NOT EXISTS adh_users (
  id VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL,
  display_name VARCHAR(191) NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY adh_users_username_uq (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adh_sessions (
  token_hash VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (token_hash),
  KEY adh_sessions_user_idx (user_id),
  CONSTRAINT adh_sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES adh_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adh_audit_logs (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NULL,
  username VARCHAR(64) NULL,
  role VARCHAR(16) NULL,
  action VARCHAR(32) NOT NULL,
  target VARCHAR(255) NULL,
  method VARCHAR(8) NULL,
  path VARCHAR(255) NULL,
  status INT NULL,
  ip VARCHAR(64) NULL,
  detail TEXT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY adh_audit_logs_created_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;