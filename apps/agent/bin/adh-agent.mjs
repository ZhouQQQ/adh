#!/usr/bin/env node
// adh-agent 启动器。
// 分发包里 src 已由打包脚本编译成 JS，直接用 node 运行，不依赖 tsx；
// 在源码目录里没有 cli.js 时回退到 tsx，方便开发调试。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 控制台默认 GBK，而日志是 UTF-8，不切代码页会中文乱码。
// 直接 `node bin/adh-agent.mjs` 启动时也走这里，覆盖到 adh-agent.cmd 之外的情况。
if (process.platform === 'win32') {
  spawnSync('cmd', ['/d', '/c', 'chcp 65001 >nul'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.join(here, '..', 'src', 'cli.js');
const source = path.join(here, '..', 'src', 'cli.ts');

const args = fs.existsSync(compiled)
  ? [compiled]
  : ['--import', 'tsx', source];

const child = spawn(
  process.execPath,
  [...args, ...process.argv.slice(2)],
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
