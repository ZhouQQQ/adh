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

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  packageDir: string;
  thumbnailDir: string;
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
  const bucket = process.env.ADH_OSS_BUCKET?.trim();
  const accessKeyId = process.env.ADH_OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.ADH_OSS_ACCESS_KEY_SECRET?.trim();
  if (!bucket || !accessKeyId || !accessKeySecret) return null;

  return {
    bucket,
    region: process.env.ADH_OSS_REGION?.trim() || 'oss-cn-hangzhou',
    endpoint: process.env.ADH_OSS_ENDPOINT?.trim() || undefined,
    accessKeyId,
    accessKeySecret,
    prefix: (process.env.ADH_OSS_PREFIX?.trim() || 'adh').replace(/^\/+|\/+$/g, ''),
    publicBaseUrl: process.env.ADH_OSS_PUBLIC_BASE_URL?.trim() || undefined,
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
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(thumbnailDir, { recursive: true });

  return {
    host: cli.host ?? process.env.ADH_HOST ?? '0.0.0.0',
    port: Number(cli.port ?? process.env.ADH_PORT ?? DEFAULT_SERVER_PORT),
    dataDir,
    dbPath: path.join(dataDir, 'adh.sqlite'),
    packageDir,
    thumbnailDir,
    publicDir: path.join(APP_DIR, 'public'),
    logLevel: cli['log-level'] ?? process.env.ADH_LOG_LEVEL ?? 'info',
    localAgent: process.env.ADH_LOCAL_AGENT !== '0',
    oss: readOssConfig(),
  };
}