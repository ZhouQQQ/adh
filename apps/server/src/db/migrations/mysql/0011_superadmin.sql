-- 角色拆分为超级管理员 / 管理员 / 普通用户，原默认账号升级为超级管理员
UPDATE adh_users SET role = 'superadmin' WHERE username IN ('admin', 'root') AND role = 'admin';