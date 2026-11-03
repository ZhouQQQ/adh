-- 去掉只读角色，已有只读用户转为操作员
UPDATE adh_users SET role = 'operator' WHERE role = 'viewer';