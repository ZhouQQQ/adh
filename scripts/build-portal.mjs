#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cwd = path.join(process.cwd(), 'apps', 'portal-android');
const command = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

const result = spawnSync(command, ['assembleDebug'], {
  cwd,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[portal] 无法启动 Gradle：${result.error.message}`);
  console.error('[portal] 需要 JDK 17 与 Android SDK 34');
  process.exit(1);
}
process.exit(result.status ?? 1);