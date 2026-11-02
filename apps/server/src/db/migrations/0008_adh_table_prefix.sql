-- 统一表名加 adh_ 前缀，并新增安装包元数据表

ALTER TABLE agents RENAME TO adh_agents;
ALTER TABLE devices RENAME TO adh_devices;

DROP INDEX IF EXISTS devices_agent_udid_idx;
DROP INDEX IF EXISTS devices_agent_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS adh_devices_agent_udid_idx
  ON adh_devices(agent_id, udid);
CREATE INDEX IF NOT EXISTS adh_devices_agent_id_idx ON adh_devices(agent_id);

-- 应用管理：安装包元数据，文件本体仍在 .data/packages
CREATE TABLE IF NOT EXISTS adh_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'apk',
  size INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS adh_packages_uploaded_at_idx
  ON adh_packages(uploaded_at DESC);