-- 安全键盘辅助层的位置，按设备保存，多人共享
ALTER TABLE adh_devices ADD COLUMN safe_keyboard TEXT NULL DEFAULT NULL;