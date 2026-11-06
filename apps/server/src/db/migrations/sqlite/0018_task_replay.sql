-- 任务执行回放：每个任务一个不可猜测的回放 token，用于公开分享回放页面
ALTER TABLE adh_tasks ADD COLUMN replay_token TEXT;

CREATE INDEX IF NOT EXISTS adh_tasks_replay_token_idx
  ON adh_tasks (replay_token);