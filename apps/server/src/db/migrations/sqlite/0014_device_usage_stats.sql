-- 设备排序用统计字段：最近接入时间、累计使用次数、最近使用时间

ALTER TABLE adh_devices ADD COLUMN connected_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adh_devices ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adh_devices ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;

-- 老数据没有接入时间，用最近一次上报时间近似
UPDATE adh_devices SET connected_at = last_seen WHERE connected_at = 0;

-- 用历史控制日志回填使用次数与最近使用时间
UPDATE adh_devices
SET use_count = (
      SELECT COUNT(*)
      FROM adh_device_logs l
      WHERE l.device_id = adh_devices.id AND l.action = 'control.start'
    ),
    last_used_at = COALESCE(
      (
        SELECT MAX(l.created_at)
        FROM adh_device_logs l
        WHERE l.device_id = adh_devices.id AND l.action = 'control.start'
      ),
      0
    );