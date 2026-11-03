-- 是否 root / 越狱：1 是，0 否，NULL 未知
ALTER TABLE adh_devices ADD COLUMN rooted TINYINT NULL DEFAULT NULL;