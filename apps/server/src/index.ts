import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { WS_PATHS, BUILTIN_AGENT_ID } from '@adh/protocol';
import { loadConfig, SERVER_VERSION } from './config.js';
import { CommandBus } from './command-bus.js';
import { openDatabase } from './db/index.js';
import { createQueries } from './db/queries.js';
import { registerHttpRoutes } from './http/routes.js';
import { LocalAgent } from './local-agent.js';
import { createLogger } from './log.js';
import { AgentRegistry } from './registry.js';
import { PackageStore } from './storage/packages.js';
import { ThumbnailStore } from './storage/thumbnails.js';
import { StreamManager } from './stream/manager.js';
import { registerAgentChannel } from './ws/agent.js';
import { registerStreamChannel } from './ws/stream.js';
import { WebHub } from './ws/web-hub.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { sqlite, db } = openDatabase(config.dbPath);
  const queries = createQueries(db);
  const registry = new AgentRegistry();
  const hub = new WebHub();
  const thumbnails = new ThumbnailStore(config.thumbnailDir);
  const packages = new PackageStore(config.packageDir);
  const commands = new CommandBus(registry);
  const streams = new StreamManager({ queries, registry, hub, logger });

  const localAgent = new LocalAgent({
    queries,
    hub,
    thumbnails,
    logger,
    version: SERVER_VERSION,
  });
  if (config.localAgent) {
    await localAgent.start();
  } else {
    logger.info('builtin local agent disabled (ADH_LOCAL_AGENT=0)');
  }

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // APK 上传需要更大的请求体上限
    bodyLimit: 512 * 1024 * 1024,
    disableRequestLogging: true,
  });

  await app.register(websocket, {
    options: { maxPayload: 32 * 1024 * 1024 },
  });

  registerAgentChannel(app, {
    queries,
    registry,
    hub,
    thumbnails,
    commands,
    serverVersion: SERVER_VERSION,
    logger,
  });

  app.get(WS_PATHS.web, { websocket: true }, (socket) => {
    hub.add(socket);
    socket.on('close', () => hub.remove(socket));
  });

  registerStreamChannel(app, streams);

  await registerHttpRoutes(app, {
    queries,
    registry,
    hub,
    thumbnails,
    packages,
    commands,
    streams,
    port: config.port,
  });

  // 静态资源与 SPA 回退：Vite 构建产物输出到 apps/server/public
  const indexHtml = path.join(config.publicDir, 'index.html');
  fs.mkdirSync(config.publicDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/',
    setHeaders: (res, filePath) => {
      // 入口 HTML 必须实时校验，否则改版后浏览器会一直用旧 bundle
      if (filePath.endsWith('index.html')) {
        res.setHeader('cache-control', 'no-cache, must-revalidate');
        return;
      }
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });

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
  logger.info(
    config.localAgent
      ? '本机设备已由内置 Agent 接管，其他宿主机请在控制台新建 Agent 接入'
      : '内置 Agent 已关闭，所有宿主机请在控制台新建 Agent 接入',
  );
  if (config.localAgent) {
    logger.info(`builtin agent: ${BUILTIN_AGENT_ID}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    localAgent.stop();
    streams.shutdown();
    commands.clear();
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