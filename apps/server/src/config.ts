import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '@adh/protocol';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');

export const SERVER_VERSION = '0.1.0';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  packageDir: string;
  thumbnailDir: string;
  publicDir: string;
  logLevel: string;
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

export function loadConfig(): ServerConfig {
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
  };
}