/**
 * 打一个可离线分发的 adh-agent 目录（可选再压成 zip）。
 *
 *   pnpm package:agent
 *
 * 产物：dist/agent/，目标机器只要有 Node 22+ 和 adb 就能直接运行：
 *   dist/agent/adh-agent.cmd connect --server ws://<server>:8080 --key adh_xxx
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'dist', 'agent');

fs.rmSync(outDir, { recursive: true, force: true });

const isWindows = process.platform === 'win32';

/** 优先用当前 pnpm 进程的 JS 入口，避免 Windows 下走 shell 拼接参数。 */
function runPnpm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /\.(c?js|mjs)$/.test(cli)) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      stdio: 'inherit',
    });
  }
  return spawnSync(isWindows ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
}

const deploy = runPnpm([
  '--filter',
  '@adh/agent',
  'deploy',
  '--prod',
  outDir,
]);
if (deploy.status !== 0) {
  process.exit(deploy.status ?? 1);
}

// pnpm deploy 可能把仓库里既有的打包产物目录一起带进来，清掉避免递归膨胀
for (const stray of ['.data', 'dist']) {
  fs.rmSync(path.join(outDir, stray), { recursive: true, force: true });
}

if (process.platform !== 'win32') {
  fs.chmodSync(path.join(outDir, 'adh-agent.sh'), 0o755);
}

console.log(`\nadh-agent 已打包到 ${outDir}`);

if (isWindows) {
  const zipPath = path.join(root, 'dist', `adh-agent-${process.platform}-${process.arch}.zip`);
  fs.rmSync(zipPath, { force: true });
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${outDir}' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`已生成 ${zipPath}`);
}

console.log(`
目标机器只需要：
  1. Node.js 22+（https://nodejs.org）
  2. adb 在 PATH 中（Android Platform Tools，Windows 还需手机 USB 驱动）
     —— 已装可忽略，没装可运行 adh-agent init 自动下载 adb 与 go-ios
  3. 能访问 server 的 8080 端口

运行：
  adh-agent.cmd init                       # 可选：自动下载 adb / go-ios
  adh-agent.cmd connect --server ws://<server-ip>:8080 --key adh_xxx
`);