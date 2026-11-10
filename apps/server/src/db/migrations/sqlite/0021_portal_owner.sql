-- 设备无线直连改用用户自己的 API Key 接入，记录这台手机是谁连的
ALTER TABLE adh_agents ADD COLUMN owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_adh_agents_owner ON adh_agents(owner_user_id);
