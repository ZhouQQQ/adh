import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpBackend } from './mcp/backend.js';
import { createAdhMcpServer } from './mcp/server.js';

const SERVER_URL = (process.env.ADH_SERVER_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  '',
);
const API_KEY = process.env.ADH_API_KEY?.trim() ?? '';

if (!API_KEY) {
  console.error(
    '[adh-mcp] 缺少 ADH_API_KEY。请先在 Web 控制台「系统设置 → API / MCP」生成 Key。',
  );
  process.exit(1);
}

const server = createAdhMcpServer(
  createHttpBackend({ baseUrl: SERVER_URL, apiKey: API_KEY }),
  '1.0.0',
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[adh-mcp] connected to ${SERVER_URL}`);