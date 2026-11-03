import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { WS_PATHS, BUILTIN_AGENT_ID } from '@adh/protocol';
import { AuthService } from './auth/service.js';
import { bearerToken } from './auth/token.js';
import { describeAudit } from './auth/audit-describe.js';
import { loadConfig, SERVER_VERSION } from './config.js';
import { CommandBus } from './command-bus.js';
import { openDatabase } from './db/index.js';
import { createQueries } from './db/queries.js';
import { DeviceLogService } from './logs/device-logs.js';
import { registerAuthRoutes } from './http/auth-routes.js';
import { registerDeviceLogRoutes } from './http/device-log-routes.js';
import { registerHttpRoutes } from './http/routes.js';
import { LocalAgent } from './local-agent.js';
import { createLogger } from './log.js';
import { AgentRegistry } from './registry.js';
import { PackageStore } from './storage/packages.js';
import { AppIconStore } from './storage/app-icons.js';
import { OssStore } from './storage/oss.js';
import { ThumbnailStore } from './storage/thumbnails.js';
import { StreamManager } from './stream/manager.js';
import { registerAgentChannel } from './ws/agent.js';
import { registerStreamChannel } from './ws/stream.js';
import { WebHub } from './ws/web-hub.js';
import { loadDashboard } from './stats/dashboard.js';
import { SettingsService } from './settings/service.js';
import { registerSettingsRoutes } from './http/settings-routes.js';

/** ADH_SERVE_WEB=0 时只提供 API，前端页面走 Vite 开发服务器。 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { driver, close: closeDatabase } = await openDatabase(config.db);
  const queries = createQueries(driver);
  const auth = new AuthService(driver);
  await auth.ensureDefaultAdmin();
  const registry = new AgentRegistry();
  const hub = new WebHub();
  const oss = config.oss ? new OssStore(config.oss) : null;
  const thumbnails = new ThumbnailStore(config.thumbnailDir, oss);
  const packages = await PackageStore.create(config.packageDir, driver, oss);
  const icons = new AppIconStore(config.appIconDir, oss);
  const commands = new CommandBus(registry);
  const deviceLogs = new DeviceLogService(driver);
  const settings = new SettingsService(
    driver,
    path.join(config.dataDir, 'branding'),
  );
  const streams = new StreamManager({ queries, registry, hub, logger, deviceLogs });
  hub.setControlResolver((deviceId) => streams.getControl(deviceId));

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

  const PUBLIC_API = new Set(['/api/health', '/api/auth/login']);

  // 登录校验：/api 和浏览器 WebSocket 需要 token，/ws/agent 走 agent key
  app.addHook('onRequest', async (request, reply) => {
    const path = (request.raw.url ?? '').split('?')[0] ?? '';
    const isApi = path.startsWith('/api');
    const isBrowserWs =
      path === WS_PATHS.web || path.startsWith(`${WS_PATHS.stream}/`);

    if (!isApi && !isBrowserWs) return;
    // 站点标题与 Logo 公开读取，登录页也要展示
    const publicSiteRead =
      request.method === 'GET' &&
      (path === '/api/settings' || path === '/api/settings/logo');
    if (PUBLIC_API.has(path) || publicSiteRead) return;

    const token = bearerToken(request);
    const user = token ? await auth.resolveToken(token) : null;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }
    request.user = user;

    if (path.startsWith('/api/users') || path.startsWith('/api/audit')) {
      if (user.role !== 'admin') {
        return reply.code(403).send({ error: '需要管理员权限' });
      }
    }
  });

  // 删除 / 修改前先取目标名称：等响应回来时记录已经被删掉，审计里就只剩 ID 了
  app.addHook('onRequest', async (request) => {
    if (request.method !== 'DELETE' && request.method !== 'PATCH') return;
    const path = (request.raw.url ?? '').split('?')[0] ?? '';
    const match = /^\/api\/(packages|devices|agents)\/([^/]+)$/.exec(path);
    if (!match) return;
    const [, kind, id] = match;
    if (!id) return;

    try {
      if (kind === 'packages') {
        const record = await packages.record(id);
        if (record) request.auditSubject = record.name;
      } else if (kind === 'devices') {
        const device = await queries.getDevice(id);
        if (device) request.auditSubject = device.name;
      } else {
        const agent = await queries.getAgent(id);
        if (agent) request.auditSubject = agent.name;
      }
    } catch {
      /* 查询失败不影响正常请求，审计里退回只用 ID / 动作 */
    }
  });

  // 写操作自动记审计日志，只记业务动作，不记接口路径
  app.addHook('onResponse', async (request, reply) => {
    const user = request.user;
    if (!user) return;
    const path = (request.raw.url ?? '').split('?')[0] ?? '';
    if (!path.startsWith('/api')) return;
    if (request.method === 'GET' || request.method === 'HEAD') return;

    const info = describeAudit({
      method: request.method,
      path,
      body: request.body,
      headers: request.headers as Record<string, unknown>,
      subjectName: request.auditSubject,
    });
    if (!info) return;

    await auth.writeAudit({
      userId: user.id,
      username: user.username,
      role: user.role,
      action: info.action,
      detail: info.detail,
      status: reply.statusCode,
      ip: request.ip,
    });
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

  app.get(WS_PATHS.web, { websocket: true }, (socket, request) => {
    hub.add(socket, request.user);
    socket.on('close', () => hub.remove(socket));
  });

  registerStreamChannel(app, streams);

  await registerAuthRoutes(app, {
    auth,
    // 单点登录：新登录把同账号的旧连接挤下线
    onLogin: (userId) => {
      hub.kickUser(userId);
      streams.kickUser(userId);
    },
  });
  await registerDeviceLogRoutes(app, { deviceLogs });

  await registerHttpRoutes(app, {
    queries,
    registry,
    hub,
    thumbnails,
    packages,
    icons,
    oss,
    agentDistDir: config.agentDistDir,
    commands,
    streams,
    deviceLogs,
    settings,
    port: config.port,
  });

  /** 仪表盘统计：用户、设备、使用时长与排行（仅管理员）。 */
  app.get('/api/dashboard', async (request, reply) => {
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    return loadDashboard({ db: driver, queries, packages, streams, registry });
  });

  await registerSettingsRoutes(app, { settings });

  // 静态资源与 SPA 回退：Vite 构建产物输出到 apps/server/public
  // ADH_SERVE_WEB=0 时只提供 API，页面统一走 Vite 开发服务器
  const indexHtml = path.join(config.publicDir, 'index.html');
  if (config.serveWeb) {
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
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.code(404).send({
        error: 'web console disabled',
        hint: 'ADH_SERVE_WEB=0，开发请访问 http://localhost:5173',
      });
    });
  }

  await app.listen({ host: config.host, port: config.port });

  logger.info(`adh-server v${SERVER_VERSION} ready`);
  logger.info(`data dir     : ${config.dataDir}`);
  logger.info(
    config.db.kind === 'mysql'
      ? `database     : mysql ${config.db.host}:${config.db.port}/${config.db.database}`
      : `database     : sqlite ${config.db.path}`,
  );
  logger.info(
    oss
      ? `object store : oss://${oss.bucket}/${oss.prefix}`
      : 'object store : local files',
  );
  logger.info(
    config.serveWeb
      ? `web console  : http://127.0.0.1:${config.port}`
      : 'web console  : 已关闭静态托管（ADH_SERVE_WEB=0），开发请用 http://localhost:5173',
  );
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
    await closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});