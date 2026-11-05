import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '@adh/protocol';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');

/**
 * server 版本号。
 *
 * 优先用构建时注入的 ADH_VERSION（Docker 镜像 / 离线包会带 tag），
 * 否则读 apps/server/package.json，最后回退到源码里的默认值。
 */
function readServerVersion(): string {
  const injected = process.env.ADH_VERSION?.trim();
  // 统一成不带 v 的版本号，日志里再拼 "v"，避免出现 vv0.1.6
  if (injected) return injected.replace(/^v(?=\d)/i, '');
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* 读不到就用默认值 */
  }
  return '0.2.0';
}

export const SERVER_VERSION = readServerVersion();

export interface OssConfig {
  bucket: string;
  region: string;
  /** 自定义 endpoint，留空用 region 推导 */
  endpoint?: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 对象根目录，默认 adh，下面的文件按类型分到 packages / thumbnails */
  prefix: string;
  /** 可选：绑定的自定义域名，用于生成直链 */
  publicBaseUrl?: string;
}

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * 数据库有两种后端，由 ADH_DB 或是否提供 MYSQL_HOST 决定：
 *   sqlite  本地单文件，开箱即用（默认，未配置 MySQL 时）
 *   mysql   外部数据库（配置了 MYSQL_HOST 时）
 */
export type DatabaseConfig =
  | { kind: 'sqlite'; path: string }
  | ({ kind: 'mysql' } & MysqlConfig);

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  db: DatabaseConfig;
  packageDir: string;
  thumbnailDir: string;
  appIconDir: string;
  /** 离线 Agent 安装包（dist/*.zip）所在目录。 */
  agentDistDir: string;
  publicDir: string;
  /** 部署前缀，例如 /adh；空串表示部署在根路径。 */
  basePath: string;
  logLevel: string;
  /** 是否启用 server 内置的本机 Agent。默认开启，ADH_LOCAL_AGENT=0 关闭。 */
  localAgent: boolean;
  /** 是否托管前端构建产物。默认开启，ADH_SERVE_WEB=0 时只提供 API（开发用 Vite）。 */
  serveWeb: boolean;
  /** OSS 配置；null 表示文件只落本地磁盘。 */
  oss: OssConfig | null;
}

function readCliOptions() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string' },
      'log-level': { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });
  return values as Record<string, string | undefined>;
}

/** 依次加载仓库根目录和 apps/server 下的 .env，已存在的环境变量优先。 */
function loadEnvFiles(): void {
  for (const file of [
    path.join(REPO_ROOT, '.env'),
    path.join(APP_DIR, '.env'),
  ]) {
    if (!fs.existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch {
      /* 格式异常时忽略，继续用进程环境变量 */
    }
  }
}

function readOssConfig(): OssConfig | null {
  // ADH_STORAGE=local 强制用本地文件；=oss 强制要求 OSS 配置
  const mode = envValue('ADH_STORAGE')?.toLowerCase();
  if (mode && mode !== 'local' && mode !== 'oss') {
    throw new Error(`ADH_STORAGE 只能是 local 或 oss，当前是 ${mode}`);
  }
  if (mode === 'local') return null;

  // 兼容 ADH_OSS_* 和阿里云常见的 OSS_* 变量名
  const bucket = envValue('ADH_OSS_BUCKET', 'OSS_BUCKET_NAME');
  const accessKeyId = envValue('ADH_OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID');
  const accessKeySecret = envValue(
    'ADH_OSS_ACCESS_KEY_SECRET',
    'OSS_ACCESS_KEY_SECRET',
  );

  if (!bucket || !accessKeyId || !accessKeySecret) {
    if (mode === 'oss') {
      throw new Error(
        'ADH_STORAGE=oss，但缺少 ADH_OSS_BUCKET / ADH_OSS_ACCESS_KEY_ID / ADH_OSS_ACCESS_KEY_SECRET',
      );
    }
    return null;
  }

  const rawRegion =
    envValue('ADH_OSS_REGION', 'OSS_REGION_ID') ?? 'oss-cn-hangzhou';

  return {
    bucket,
    region: rawRegion.startsWith('oss-') ? rawRegion : `oss-${rawRegion}`,
    endpoint: envValue('ADH_OSS_ENDPOINT', 'OSS_ENDPOINT'),
    accessKeyId,
    accessKeySecret,
    prefix: (envValue('ADH_OSS_PREFIX') ?? 'adh').replace(/^\/+|\/+$/g, ''),
    publicBaseUrl: envValue('ADH_OSS_PUBLIC_BASE_URL'),
  };
}

/**
 * 部署前缀：ADH_BASE_PATH=/adh 时所有页面、接口、WebSocket 都在 /adh 下。
 * 空值或 / 表示根路径。写法宽松：adh、/adh、/adh/ 都会规范化成 /adh。
 */
export function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readMysqlConfig(): MysqlConfig {
  const required = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_DB'];
  const missing = required.filter((key) => !envValue(key));

  if (missing.length > 0) {
    throw new Error(
      `ADH_DB=mysql，但缺少配置：${missing.join(', ')}（可写在仓库根 .env）`,
    );
  }

  return {
    host: envValue('MYSQL_HOST')!,
    port: Number(envValue('MYSQL_PORT') ?? 3306),
    user: envValue('MYSQL_USER')!,
    password: envValue('MYSQL_PASSWORD') ?? '',
    database: envValue('MYSQL_DB')!,
  };
}

function readDatabaseConfig(dataDir: string): DatabaseConfig {
  const explicit = envValue('ADH_DB')?.toLowerCase();
  if (explicit && explicit !== 'sqlite' && explicit !== 'mysql') {
    throw new Error(`ADH_DB 只能是 sqlite 或 mysql，当前是 ${explicit}`);
  }

  // 没显式指定时：有 MYSQL_HOST 就用 MySQL，否则用本地 SQLite
  const kind = explicit ?? (envValue('MYSQL_HOST') ? 'mysql' : 'sqlite');

  if (kind === 'sqlite') {
    return { kind: 'sqlite', path: path.join(dataDir, 'adh.sqlite') };
  }

  return { kind: 'mysql', ...readMysqlConfig() };
}

export function loadConfig(): ServerConfig {
  loadEnvFiles();
  const cli = readCliOptions();
  const dataDir = path.resolve(
    cli.data ?? process.env.ADH_DATA_DIR ?? path.join(REPO_ROOT, '.data'),
  );
  const packageDir = path.join(dataDir, 'packages');
  const thumbnailDir = path.join(dataDir, 'thumbnails');
  const appIconDir = path.join(dataDir, 'app-icons');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(thumbnailDir, { recursive: true });
  fs.mkdirSync(appIconDir, { recursive: true });

  return {
    host: cli.host ?? process.env.ADH_HOST ?? '0.0.0.0',
    port: Number(cli.port ?? process.env.ADH_PORT ?? DEFAULT_SERVER_PORT),
    dataDir,
    db: readDatabaseConfig(dataDir),
    packageDir,
    thumbnailDir,
    appIconDir,
    agentDistDir: path.join(REPO_ROOT, 'dist'),
    publicDir: path.join(APP_DIR, 'public'),
    basePath: normalizeBasePath(process.env.ADH_BASE_PATH),
    logLevel: cli['log-level'] ?? process.env.ADH_LOG_LEVEL ?? 'info',
    localAgent: process.env.ADH_LOCAL_AGENT !== '0',
    serveWeb: process.env.ADH_SERVE_WEB !== '0',
    oss: readOssConfig(),
  };
}