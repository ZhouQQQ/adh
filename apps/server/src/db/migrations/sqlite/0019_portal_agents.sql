-- 设备直连：Portal 设备使用平台全局 Key，每台设备一行 agent
ALTER TABLE adh_agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'host';
ALTER TABLE adh_agents ADD COLUMN instance_id TEXT;
CREATE INDEX IF NOT EXISTS idx_adh_agents_instance ON adh_agents(instance_id);
CREATE INDEX IF NOT EXISTS idx_adh_agents_kind ON adh_agents(kind);