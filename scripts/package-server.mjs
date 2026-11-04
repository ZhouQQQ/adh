/**
 * 打可离线分发的 adh-server 包：解压后 `node` 直接跑。
 *
 *   pnpm package:server                    # 当前平台
 *   pnpm package:server --platform linux   # 指定平台
 *
 * 产物：
 *   dist/server-<platform>/          自包含目录（前端产物 + 生产依赖）
 *   dist/adh-server-<platform>.zip   解压后执行 start.sh / start.cmd
 *
 * sharp 是原生模块、平台相关：Linux 包要在 Linux 上打，Windows 包要在 Windows 上打。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);

const ALL_PLATFORMS = ['linux', 'win32', 'darwin'];

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function currentPlatform() {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function parsePlatforms(raw) {
  if (!raw || raw === 'all') return [currentPlatform()];
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = list.filter((item) => !ALL_PLATFORMS.includes(item));
  if (invalid.length > 0) {
    console.error(
      `不支持的平台：${invalid.join(', ')}（可选：${ALL_PLATFORMS.join(', ')}）`,
    );
    process.exit(1);
  }
  return [...new Set(list)];
}

/** 优先用当前 pnpm 进程的 JS 入口，避免 Windows 下走 shell 拼接参数。 */
function runPnpm(pnpmArgs) {
  const cli = process.env.npm_execpath;
  if (cli && /\.(c?js|mjs)$/.test(cli)) {
    return spawnSync(process.execPath, [cli, ...pnpmArgs], {
      cwd: root,
      stdio: 'inherit',
    });
  }
  return spawnSync(isWindows ? 'pnpm.cmd' : 'pnpm', pnpmArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
}

function zipDir(dir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (isWindows) {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${dir}' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) return false;
    // 中途中断会留下 0 字节文件，直接清掉
    if (fs.existsSync(zipPath) && fs.statSync(zipPath).size < 1024) {
      fs.rmSync(zipPath, { force: true });
      return false;
    }
    return true;
  }
  const result = spawnSync('zip', ['-qr', zipPath, path.basename(dir)], {
    cwd: path.dirname(dir),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.warn('  未找到 zip 命令，已保留目录，可手动压缩');
    return false;
  }
  return true;
}

/** 写启动脚本，数据默认落在包内的 data/ 目录。 */
function writeLaunchers(outDir) {
  fs.writeFileSync(
    path.join(outDir, 'start.cmd'),
    '@echo off\r\n' +
      'cd /d "%~dp0"\r\n' +
      'if "%ADH_DATA_DIR%"=="" set "ADH_DATA_DIR=%~dp0data"\r\n' +
      'node node_modules\\tsx\\dist\\cli.mjs src\\index.ts %*\r\n',
  );

  const sh =
    '#!/usr/bin/env sh\n' +
    'cd "$(dirname "$0")"\n' +
    'export ADH_DATA_DIR="${ADH_DATA_DIR:-$PWD/data}"\n' +
    'exec node node_modules/tsx/dist/cli.mjs src/index.ts "$@"\n';
  fs.writeFileSync(path.join(outDir, 'start.sh'), sh);
  fs.chmodSync(path.join(outDir, 'start.sh'), 0o755);
}

async function main() {
  const platforms = parsePlatforms(argValue('--platform'));
  fs.mkdirSync(distDir, { recursive: true });

  console.log('构建前端（产出 apps/server/public）');
  const web = runPnpm(['--filter', '@adh/web', 'build']);
  if (web.status !== 0) process.exit(web.status ?? 1);

  const publicDir = path.join(root, 'apps', 'server', 'public');
  if (!fs.existsSync(publicDir)) {
    console.error('缺少前端产物 apps/server/public');
    process.exit(1);
  }

  const results = [];

  for (const platform of platforms) {
    const outDir = path.join(distDir, `server-${platform}`);
    fs.rmSync(outDir, { recursive: true, force: true });

    console.log(`\n部署 @adh/server → ${outDir}`);
    // hoisted：node_modules 用真实目录，避免 pnpm 的 junction 让 Compress-Archive 失败
    const deploy = runPnpm([
      '--filter',
      '@adh/server',
      'deploy',
      '--prod',
      '--config.node-linker=hoisted',
      outDir,
    ]);
    if (deploy.status !== 0) process.exit(deploy.status ?? 1);

    // pnpm deploy 会把仓库里既有的临时目录一起带进来
    for (const entry of fs.readdirSync(outDir)) {
      if (entry === '.data' || entry === 'dist' || entry.startsWith('.deploy')) {
        fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
      }
    }

    // 前端产物：server 从 <APP_DIR>/public 读取
    fs.cpSync(publicDir, path.join(outDir, 'public'), { recursive: true });
    writeLaunchers(outDir);

    const zipPath = path.join(distDir, `adh-server-${platform}.zip`);
    const zipped = zipDir(outDir, zipPath);
    results.push({
      platform,
      dir: outDir,
      zip: zipped ? zipPath : null,
      size: zipped ? fs.statSync(zipPath).size : 0,
    });
    console.log(`  ${zipped ? `已生成 ${zipPath}` : '未生成 zip'}`);
  }

  console.log('\n构建完成：');
  for (const item of results) {
    const size = item.size ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : '—';
    console.log(`  ${item.platform.padEnd(7)} ${size.padStart(8)}  ${item.zip ?? item.dir}`);
  }

  console.log(`
目标机器只需要 Node.js 22+（https://nodejs.org）

  Linux / macOS:  ./start.sh
  Windows:        start.cmd

默认监听 8080，数据保存在包内 data/ 目录。
`);
}

await main();
