import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { WS_PATHS } from '@adh/protocol';
import { loadConfig, SERVER_VERSION } from './config.js';
import { openDatabase } from './db/index.js';
import { createQueries } from './db/queries.js';
import { registerHttpRoutes } from './http/routes.js';
import { createLogger } from './log.js';
import { AgentRegistry } from './registry.js';
import { registerAgentChannel } from './ws/agent.js';
import { WebHub } from './ws/web-hub.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { sqlite, db } = openDatabase(config.dbPath);
  const queries = createQueries(db);
  const registry = new AgentRegistry();
  const hub = new WebHub();

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: 32 * 1024 * 1024,
  });

  await app.register(websocket, {
    options: { maxPayload: 32 * 1024 * 1024 },
  });

  registerAgentChannel(app, {
    queries,
    registry,
    hub,
    registrationCode: config.registrationCode,
    serverVersion: SERVER_VERSION,
    logger,
  });

  app.get(WS_PATHS.web, { websocket: true }, (socket) => {
    hub.add(socket);
    socket.on('close', () => hub.remove(socket));
  });

  await registerHttpRoutes(app, { queries, registry });

  // 静态资源与 SPA 回退：Vite 构建产物输出到 apps/server/public
  const indexHtml = path.join(config.publicDir, 'index.html');
  fs.mkdirSync(config.publicDir, { recursive: true });
  await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (!fs.existsSync(indexHtml)) {
      return reply.code(404).send({
        error: 'web console not built',
        hint: 'run `pnpm --filter @adh/web build` or use the vite dev server',
      });
    }
    return reply.sendFile('index.html');
  });

  await app.listen({ host: config.host, port: config.port });

  logger.info(`adh-server v${SERVER_VERSION} ready`);
  logger.info(`data dir     : ${config.dataDir}`);
  logger.info(`web console  : http://127.0.0.1:${config.port}`);
  logger.info(`agent code   : ${config.registrationCode}`);
  logger.info(
    `connect      : adh-agent connect --server ws://<此机IP>:${config.port} --code ${config.registrationCode}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});