-- 设备无线直连改用用户自己的 API Key 接入，记录这台手机是谁连的
-- 用 information_schema 判断，避免并发实例或中断后重跑时报 Duplicate column
SET @has_owner := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'adh_agents'
    AND column_name = 'owner_user_id'
);
SET @sql := IF(
  @has_owner = 0,
  'ALTER TABLE adh_agents ADD COLUMN owner_user_id VARCHAR(64) NULL',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'adh_agents'
    AND index_name = 'idx_adh_agents_owner'
);
SET @sql := IF(
  @has_idx = 0,
  'CREATE INDEX idx_adh_agents_owner ON adh_agents(owner_user_id)',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
