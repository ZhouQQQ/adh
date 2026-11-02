import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '@adh/protocol';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');

export const SERVER_VERSION = '0.1.0';

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

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  mysql: MysqlConfig;
  packageDir: string;
  thumbnailDir: string;
  appIconDir: string;
  /** 离线 Agent 安装包（dist/*.zip）所在目录。 */
  agentDistDir: string;
  publicDir: string;
  logLevel: string;
  /** 是否启用 server 内置的本机 Agent。默认开启，ADH_LOCAL_AGENT=0 关闭。 */
  localAgent: boolean;
  /** OSS 配置；未配置时文件只落本地磁盘。 */
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
  // 兼容 ADH_OSS_* 和阿里云常见的 OSS_* 变量名
  const bucket = envValue('ADH_OSS_BUCKET', 'OSS_BUCKET_NAME');
  const accessKeyId = envValue('ADH_OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID');
  const accessKeySecret = envValue(
    'ADH_OSS_ACCESS_KEY_SECRET',
    'OSS_ACCESS_KEY_SECRET',
  );
  if (!bucket || !accessKeyId || !accessKeySecret) return null;

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
      `缺少 MySQL 配置：${missing.join(', ')}（可写在仓库根 .env）`,
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
    mysql: readMysqlConfig(),
    packageDir,
    thumbnailDir,
    appIconDir,
    agentDistDir: path.join(REPO_ROOT, 'dist'),
    publicDir: path.join(APP_DIR, 'public'),
    logLevel: cli['log-level'] ?? process.env.ADH_LOG_LEVEL ?? 'info',
    localAgent: process.env.ADH_LOCAL_AGENT !== '0',
    oss: readOssConfig(),
  };
}