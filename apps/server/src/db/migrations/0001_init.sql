-- ADH 初始化（MySQL 8 / OceanBase MySQL 模式）
-- 时间戳统一存毫秒：BIGINT；JSON 字段直接存 TEXT

CREATE TABLE IF NOT EXISTS adh_agents (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(191) NOT NULL,
  host_name VARCHAR(191) DEFAULT NULL,
  os VARCHAR(32) NOT NULL,
  arch VARCHAR(32) NOT NULL,
  version VARCHAR(64) NOT NULL,
  capabilities TEXT NOT NULL,
  token VARCHAR(128) NOT NULL,
  last_seen BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY adh_agents_token_uq (token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adh_devices (
  id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  udid VARCHAR(191) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  name VARCHAR(191) NOT NULL,
  model VARCHAR(191) DEFAULT NULL,
  market_name VARCHAR(191) DEFAULT NULL,
  brand VARCHAR(191) DEFAULT NULL,
  os_version VARCHAR(64) DEFAULT NULL,
  sdk INT DEFAULT NULL,
  cpu VARCHAR(191) DEFAULT NULL,
  cpu_vendor VARCHAR(191) DEFAULT NULL,
  cpu_model VARCHAR(191) DEFAULT NULL,
  cpu_cores INT DEFAULT NULL,
  memory_mb INT DEFAULT NULL,
  resolution VARCHAR(64) DEFAULT NULL,
  status VARCHAR(32) NOT NULL,
  capabilities TEXT NOT NULL,
  tags TEXT NOT NULL,
  last_seen BIGINT NOT NULL DEFAULT 0,
  thumbnail_at BIGINT NOT NULL DEFAULT 0,
  thumbnail_source VARCHAR(16) NOT NULL,
  published_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY adh_devices_agent_udid_idx (agent_id, udid),
  KEY adh_devices_agent_id_idx (agent_id),
  CONSTRAINT adh_devices_agent_fk
    FOREIGN KEY (agent_id) REFERENCES adh_agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adh_packages (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(8) NOT NULL,
  size BIGINT NOT NULL,
  uploaded_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY adh_packages_uploaded_at_idx (uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;