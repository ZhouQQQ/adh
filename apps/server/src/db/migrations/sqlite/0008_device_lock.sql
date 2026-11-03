-- 管理员锁定设备：锁定后普通用户不能控制也不能查看
ALTER TABLE adh_devices ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adh_devices ADD COLUMN locked_by TEXT;
ALTER TABLE adh_devices ADD COLUMN locked_at INTEGER NOT NULL DEFAULT 0;