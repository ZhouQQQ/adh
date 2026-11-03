-- CPU 架构，如 arm64-v8a
ALTER TABLE adh_devices ADD COLUMN cpu_arch TEXT;
-- SoC 代号，如 sm8250 / mt6893
ALTER TABLE adh_devices ADD COLUMN cpu_code TEXT;