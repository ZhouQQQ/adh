-- 普通用户默认同时控制上限由 1 台调整为 2 台（仅更新历史上未自定义过的值）
UPDATE adh_settings SET value = '2' WHERE name = 'control.maxDevices.operator' AND value = '1';