-- 安装包备注与标签（标签用 JSON 数组字符串）
ALTER TABLE adh_packages ADD COLUMN remark TEXT NULL;
ALTER TABLE adh_packages ADD COLUMN tags TEXT NULL;