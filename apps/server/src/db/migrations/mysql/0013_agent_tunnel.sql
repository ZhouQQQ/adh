-- 节点级 iOS 隧道状态（JSON：running / tunnels / error / updatedAt）
ALTER TABLE adh_agents ADD COLUMN tunnel_status TEXT NULL;