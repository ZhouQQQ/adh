#!/usr/bin/env node
// adh-agent 启动器：用 node --import tsx 直接跑 TypeScript 入口，
// 这样打包后的目录不需要 pnpm / 全局 tsx，只要有 Node 就能运行。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'cli.ts');

const child = spawn(
  process.execPath,
  ['--import', 'tsx', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`启动 adh-agent 失败: ${error.message}`);
  process.exit(1);
});