-- API Key 明文回显：MCP 配置页需要直接给出可用的 key
ALTER TABLE adh_api_keys ADD COLUMN token_plain VARCHAR(128) NULL;
