-- iOS 设备的 WDA 转发端口（由设备所在 agent 分配并上报，8100 起递增）
ALTER TABLE adh_devices ADD COLUMN wda_port INTEGER;
