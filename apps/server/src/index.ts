import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
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
import { isAdminRole } from './auth/service.js';
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

  const basePath = config.basePath;

  /** 去掉部署前缀，后面的判断统一用 /api、/ws 开头的相对路径。 */
  const stripBase = (urlPath: string): string => {
    if (!basePath) return urlPath;
    if (urlPath === basePath) return '/';
    if (urlPath.startsWith(`${basePath}/`)) {
      return urlPath.slice(basePath.length);
    }
    return urlPath;
  };

  // 登录校验：/api 和浏览器 WebSocket 需要 token，/ws/agent 走 agent key
  app.addHook('onRequest', async (request, reply) => {
    const rawPath = (request.raw.url ?? '').split('?')[0] ?? '';
    // 前缀之外的请求直接放行，交给 404 处理，避免误报 401
    const underBase =
      !basePath || rawPath === basePath || rawPath.startsWith(`${basePath}/`);
    if (!underBase) return;

    const path = stripBase(rawPath);
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

    if (path.startsWith('/api/users') && !isAdminRole(user.role)) {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    if (path.startsWith('/api/device-logs') && !isAdminRole(user.role)) {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    // 以下功能仅超级管理员
    if (
      path.startsWith('/api/audit') ||
      (path.startsWith('/api/settings') && request.method !== 'GET') ||
      (path.startsWith('/api/agents') && request.method !== 'GET')
    ) {
      if (user.role !== 'superadmin') {
        return reply.code(403).send({ error: '需要超级管理员权限' });
      }
    }
  });

  // 删除 / 修改前先取目标名称：等响应回来时记录已经被删掉，审计里就只剩 ID 了
  app.addHook('onRequest', async (request) => {
    if (request.method !== 'DELETE' && request.method !== 'PATCH') return;
    const path = stripBase((request.raw.url ?? '').split('?')[0] ?? '');
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
    const path = stripBase((request.raw.url ?? '').split('?')[0] ?? '');
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

  // 页面、API、WebSocket 统一注册在这个插件里；
  // 配置 ADH_BASE_PATH 时整体挂到该前缀下，默认仍是根路径。
  const registerApiRoutes = async (scope: FastifyInstance): Promise<void> => {
    registerAgentChannel(scope, {
      queries,
      registry,
      hub,
      thumbnails,
      commands,
      serverVersion: SERVER_VERSION,
      logger,
    });

    scope.get(WS_PATHS.web, { websocket: true }, (socket, request) => {
      hub.add(socket, request.user);
      socket.on('close', () => hub.remove(socket));
    });

    registerStreamChannel(scope, streams);

    await registerAuthRoutes(scope, {
      auth,
      // 单点登录：新登录把同账号的旧连接挤下线
      onLogin: (userId) => {
        hub.kickUser(userId);
        streams.kickUser(userId);
      },
    });
    await registerDeviceLogRoutes(scope, { deviceLogs });

    await registerHttpRoutes(scope, {
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
      basePath,
    });

    /** 仪表盘统计：用户、设备、使用时长与排行（管理员及以上）。 */
    scope.get('/api/dashboard', async (request, reply) => {
      if (!isAdminRole(request.user?.role ?? '')) {
        return reply.code(403).send({ error: '需要管理员权限' });
      }
      return loadDashboard({ db: driver, queries, packages, streams, registry });
    });

    await registerSettingsRoutes(scope, { settings });
  };

  await app.register(registerApiRoutes, basePath ? { prefix: basePath } : {});

  // 静态资源与 SPA 回退：Vite 构建产物输出到 apps/server/public
  // ADH_SERVE_WEB=0 时只提供 API，页面统一走 Vite 开发服务器
  const indexHtmlPath = path.join(config.publicDir, 'index.html');
  let indexHtmlCache: string | null | undefined;
  const renderIndexHtml = (): string | null => {
    if (indexHtmlCache !== undefined) return indexHtmlCache;
    if (!fs.existsSync(indexHtmlPath)) {
      indexHtmlCache = null;
      return null;
    }
    // 运行时注入前缀：镜像不用为不同部署路径重新构建
    const inject =
      `<base href="${basePath}/">\n    ` +
      `<script>window.__ADH_BASE__=${JSON.stringify(basePath)}</script>\n    `;
    // 兼容旧构建产物：构建时可能已经固化了一份空前缀，
    // 不清掉的话运行时会注入第二份，两段脚本互相覆盖
    const source = fs
      .readFileSync(indexHtmlPath, 'utf8')
      .replace(/<base[^>]*>\s*/gi, '')
      .replace(/<script>\s*window\.__ADH_BASE__=[^<]*<\/script>\s*/g, '');
    indexHtmlCache = source.replace('<head>', `<head>\n    ${inject}`);
    return indexHtmlCache;
  };

  const sendIndex = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const html = renderIndexHtml();
    if (html === null) {
      return reply.code(404).send({
        error: 'web console not built',
        hint: 'run `pnpm --filter @adh/web build` or use the vite dev server',
      });
    }
    return reply
      .header('cache-control', 'no-cache, must-revalidate')
      .type('text/html')
      .send(html);
  };

  if (config.serveWeb) {
    fs.mkdirSync(config.publicDir, { recursive: true });

    if (basePath) {
      app.get('/', (_request, reply) => reply.redirect(`${basePath}/`));
      app.get(basePath, (_request, reply) => reply.redirect(`${basePath}/`));
    }
    app.get(basePath ? `${basePath}/` : '/', sendIndex);
    app.get(basePath ? `${basePath}/index.html` : '/index.html', sendIndex);

    await app.register(fastifyStatic, {
      root: config.publicDir,
      prefix: `${basePath}/`,
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const rawPath = (request.raw.url ?? '').split('?')[0] ?? '';
    const underBase =
      !basePath || rawPath === basePath || rawPath.startsWith(`${basePath}/`);
    if (!underBase) {
      return reply.code(404).send({
        error: 'not found',
        hint: `应用部署在 ${basePath}/`,
      });
    }

    const relativePath = stripBase(rawPath);
    if (relativePath.startsWith('/api') || relativePath.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    // 静态资源找不到就是 404，不要回退成页面
    if (relativePath.startsWith('/assets/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (!config.serveWeb) {
      return reply.code(404).send({
        error: 'web console disabled',
        hint: 'ADH_SERVE_WEB=0，开发请访问 http://localhost:5173',
      });
    }
    return sendIndex(request, reply);
  });

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
      ? `web console  : http://127.0.0.1:${config.port}${basePath}/`
      : 'web console  : 已关闭静态托管（ADH_SERVE_WEB=0），开发请用 http://localhost:5173',
  );
  if (basePath) {
    logger.info(`base path    : ${basePath}`);
  }
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