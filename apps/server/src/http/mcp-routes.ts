import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyService } from '../auth/api-keys.js';
import type { AuthUser } from '../auth/service.js';
import { bearerToken } from '../auth/token.js';
import type { Queries } from '../db/queries.js';
import type { Logger } from '../log.js';
import { createLocalBackend } from '../mcp/backend.js';
import { createAdhMcpServer } from '../mcp/server.js';
import type { AgentRegistry } from '../registry.js';
import type { StreamManager } from '../stream/manager.js';
import type { TaskService } from '../tasks/service.js';

export interface McpRouteDeps {
  apiKeys: ApiKeyService;
  queries: Queries;
  registry: AgentRegistry;
  streams: StreamManager;
  tasks: TaskService;
  logger: Logger;
  version: string;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  userId: string;
  lastActive: number;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;

function sessionIdOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['mcp-session-id'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

/** 同时支持高德风格的 `?key=adhk_xxx` 和标准 `Authorization: Bearer`。 */
function tokenOf(request: FastifyRequest): string | null {
  const query = request.query as { key?: unknown } | undefined;
  if (typeof query?.key === 'string' && query.key.trim()) {
    return query.key.trim();
  }
  return bearerToken(request);
}

function rpcError(
  reply: FastifyReply,
  status: number,
  code: number,
  message: string,
) {
  return reply.code(status).send({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

/**
 * MCP Streamable HTTP endpoint。
 *
 * 客户端只需配置 `url`，例如 `https://adh.example.com/mcp?key=adhk_xxx`：
 * - POST 初始化后返回 `Mcp-Session-Id`，后续请求复用它
 * - GET 建立服务端 SSE 通知流
 * - DELETE 主动结束会话
 *
 * 会话按用户隔离；带 Key 的请求必须与创建会话的用户一致。
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRouteDeps,
): void {
  const sessions = new Map<string, McpSession>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActive <= SESSION_IDLE_MS) continue;
      sessions.delete(id);
      void session.transport.close().catch(() => undefined);
    }
  }, SESSION_SWEEP_MS);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  async function resolveUser(
    request: FastifyRequest,
  ): Promise<
    { token: string | null; user: AuthUser | null; invalid: boolean }
  > {
    const token = tokenOf(request);
    if (!token) return { token: null, user: null, invalid: false };
    const user = await deps.apiKeys.resolve(token);
    return { token, user, invalid: user === null };
  }

  /** transport 直接写原始响应，交给它之前必须先 hijack。 */
  async function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    transport: StreamableHTTPServerTransport,
    body?: unknown,
  ): Promise<void> {
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, body);
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'mcp request failed',
      );
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  }

  app.post('/mcp', async (request, reply) => {
    const sessionId = sessionIdOf(request);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    const { token, user, invalid } = await resolveUser(request);

    if (existing) {
      if (invalid || (user && user.id !== existing.userId)) {
        return rpcError(reply, 403, -32001, 'API Key 与会话用户不一致');
      }
      existing.lastActive = Date.now();
      await forward(request, reply, existing.transport, request.body);
      return;
    }

    if (sessionId) {
      return rpcError(reply, 404, -32001, 'Session not found');
    }
    if (!user) {
      return rpcError(reply, 401, -32001, '缺少有效的 API Key');
    }
    if (!isInitializeRequest(request.body)) {
      return rpcError(reply, 400, -32000, 'No valid session ID provided');
    }

    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          userId: user.id,
          lastActive: Date.now(),
        });
        deps.logger.info(
          { sessionId: id, userId: user.id },
          'mcp session initialized',
        );
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) {
        deps.logger.info({ sessionId: id }, 'mcp session closed');
      }
    };

    try {
      const server = createAdhMcpServer(
        createLocalBackend(
          {
            queries: deps.queries,
            registry: deps.registry,
            streams: deps.streams,
            tasks: deps.tasks,
          },
          user,
        ),
        deps.version,
      );
      await server.connect(transport);
      await forward(request, reply, transport, request.body);
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'mcp initialize failed',
      );
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  });

  app.get('/mcp', async (request, reply) => {
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      return rpcError(reply, 400, -32000, 'Missing session ID');
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return rpcError(reply, 404, -32001, 'Session not found');
    }

    const { token, user, invalid } = await resolveUser(request);
    if (token && (invalid || user?.id !== session.userId)) {
      return rpcError(reply, 403, -32001, 'API Key 与会话用户不一致');
    }

    session.lastActive = Date.now();
    await forward(request, reply, session.transport);
  });

  app.delete('/mcp', async (request, reply) => {
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      return rpcError(reply, 400, -32000, 'Missing session ID');
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return rpcError(reply, 404, -32001, 'Session not found');
    }

    const { token, user, invalid } = await resolveUser(request);
    if (token && (invalid || user?.id !== session.userId)) {
      return rpcError(reply, 403, -32001, 'API Key 与会话用户不一致');
    }

    session.lastActive = Date.now();
    await forward(request, reply, session.transport);
  });
}