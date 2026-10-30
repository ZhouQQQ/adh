import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '@adh/protocol';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');

export const SERVER_VERSION = '0.1.0';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChunk(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  }
  return out;
}

export function generateRegistrationCode(): string {
  return `ADH-${randomChunk(4)}-${randomChunk(4)}`;
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  packageDir: string;
  publicDir: string;
  logLevel: string;
  registrationCode: string;
}

function readCliOptions() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string' },
      code: { type: 'string' },
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
  fs.mkdirSync(packageDir, { recursive: true });

  return {
    host: cli.host ?? process.env.ADH_HOST ?? '0.0.0.0',
    port: Number(cli.port ?? process.env.ADH_PORT ?? DEFAULT_SERVER_PORT),
    dataDir,
    dbPath: path.join(dataDir, 'adh.sqlite'),
    packageDir,
    publicDir: path.join(APP_DIR, 'public'),
    logLevel: cli['log-level'] ?? process.env.ADH_LOG_LEVEL ?? 'info',
    registrationCode:
      cli.code ?? process.env.ADH_REGISTRATION_CODE ?? generateRegistrationCode(),
  };
}