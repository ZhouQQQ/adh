import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalConfig {
  token?: string;
  serverUrl?: string;
  name?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.adh');
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json');

export function loadLocalConfig(): LocalConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as LocalConfig;
  } catch {
    return {};
  }
}

export function saveLocalConfig(patch: Partial<LocalConfig>): LocalConfig {
  const merged = { ...loadLocalConfig(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export function configFilePath(): string {
  return CONFIG_FILE;
}