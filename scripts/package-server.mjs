/**
 * 打可离线分发的 adh-server 包：解压后 `node` 直接跑。
 *
 *   pnpm package:server                            # 当前平台
 *   pnpm package:server --platform linux,win32     # 指定平台（可逗号分隔）
 *
 * 产物：
 *   dist/server-<platform>/          自包含目录（前端产物 + 生产依赖）
 *   dist/adh-server-<platform>.zip   解压后执行 start.sh / start.cmd
 *
 * 跨平台说明：
 *   打包时把 TypeScript 预编译成 JS，产物不再依赖 tsx / esbuild；
 *   sharp 的原生二进制按目标平台从 npm registry 补齐，
 *   因此三个平台都可以在同一个 Linux runner 上产出。
 */
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const buildBase = path.join(root, '.data', 'server-build', 'base');
const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);

const ALL_PLATFORMS = ['linux', 'win32', 'darwin'];

/** 每个目标平台需要的 sharp 原生包（win32 / darwin 需从 registry 补） */
const SHARP_TARGETS = {
  win32: ['sharp-win32-x64'],
  darwin: [
    'sharp-darwin-arm64',
    'sharp-libvips-darwin-arm64',
    'sharp-darwin-x64',
    'sharp-libvips-darwin-x64',
  ],
  linux: ['sharp-linux-x64'],
};

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
      'rem Switch console to UTF-8, otherwise Chinese log output is garbled.\r\n' +
      'chcp 65001 >nul\r\n' +
      'cd /d "%~dp0"\r\n' +
      'if "%ADH_DATA_DIR%"=="" set "ADH_DATA_DIR=%~dp0data"\r\n' +
      'node src\\index.js %*\r\n',
  );

  const sh =
    '#!/usr/bin/env sh\n' +
    'cd "$(dirname "$0")"\n' +
    'export ADH_DATA_DIR="${ADH_DATA_DIR:-$PWD/data}"\n' +
    'exec node src/index.js "$@"\n';
  fs.writeFileSync(path.join(outDir, 'start.sh'), sh);
  fs.chmodSync(path.join(outDir, 'start.sh'), 0o755);
}

/* ---------------------------------------------------------------- */
/* TypeScript 预编译                                                  */
/* ---------------------------------------------------------------- */

function listTsFiles(dir) {
  const result = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        result.push(full);
      }
    }
  };
  walk(dir);
  return result;
}

function patchPackageJson(file, patch) {
  if (!fs.existsSync(file)) return;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(patch)) pkg[key] = value;
  // pnpm 的文件可能是硬链接，先断开再写，避免改到仓库源码
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** pnpm 的 file: 依赖可能是符号链接，改写前先复制成实体目录。 */
function materialize(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  const real = fs.realpathSync(dir);
  fs.unlinkSync(dir);
  fs.cpSync(real, dir, { recursive: true });
}

function removePackage(base, name, pnpmPrefix) {
  const direct = path.join(base, 'node_modules', name);
  try {
    const stat = fs.lstatSync(direct);
    if (stat.isSymbolicLink()) fs.unlinkSync(direct);
    else fs.rmSync(direct, { recursive: true, force: true });
  } catch {
    /* 不存在 */
  }

  const pnpmDir = path.join(base, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith(pnpmPrefix)) {
        fs.rmSync(path.join(pnpmDir, entry), { recursive: true, force: true });
      }
    }
  }
}

function stripTypeScriptSources(base) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        fs.rmSync(full, { force: true });
      }
    }
  };
  walk(path.join(base, 'node_modules'));
}

async function compileTypeScript(base) {
  console.log('编译 TypeScript（产物不再依赖 tsx / esbuild）');
  for (const name of ['protocol', 'device-host']) {
    materialize(path.join(base, 'node_modules', '@adh', name));
  }

  const targets = [
    path.join(base, 'src'),
    path.join(base, 'node_modules', '@adh', 'protocol', 'src'),
    path.join(base, 'node_modules', '@adh', 'device-host', 'src'),
  ];

  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    const files = listTsFiles(dir);
    if (files.length === 0) continue;
    await build({
      entryPoints: files,
      outdir: dir,
      outbase: dir,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      bundle: false,
      sourcemap: false,
      allowOverwrite: true,
      logLevel: 'warning',
      tsconfigRaw: {},
    });
    for (const file of files) fs.rmSync(file, { force: true });
  }

  patchPackageJson(path.join(base, 'package.json'), { main: './src/index.js' });
  for (const name of ['protocol', 'device-host']) {
    patchPackageJson(
      path.join(base, 'node_modules', '@adh', name, 'package.json'),
      { exports: { '.': { default: './src/index.js' } } },
    );
  }

  removePackage(base, 'tsx', 'tsx@');
  removePackage(base, 'esbuild', 'esbuild@');
  removePackage(base, '@esbuild', '@esbuild+');
  stripTypeScriptSources(base);
}

/* ---------------------------------------------------------------- */
/* sharp 平台包                                                       */
/* ---------------------------------------------------------------- */

async function download(url, dest) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'adh-server-packager' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
}

function readVersion(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return fallback;
  }
}

/** 从 npm registry 取指定版本的包，解压到 node_modules 目标目录。 */
async function fetchNpmPackage(name, version, destDir) {
  const short = name.split('/').pop();
  const url = `https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-npm-'));
  const tgz = path.join(tmp, 'pkg.tgz');
  console.log(`  补充 ${name}@${version}`);
  await download(url, tgz);
  // 用 cwd 而不是 tar -C：Windows 下 tar 会把 C:\ 当成远程主机
  const result = spawnSync('tar', ['-xzf', tgz], {
    cwd: tmp,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`解压失败：${name}@${version}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(path.join(tmp, 'package'), destDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function injectSharp(outDir, platform) {
  const sharpPkg = path.join(outDir, 'node_modules', 'sharp', 'package.json');
  if (!fs.existsSync(sharpPkg)) return;

  const sharpVersion = readVersion(sharpPkg, '0.33.5');
  const libvipsVersion = readVersion(
    path.join(
      outDir,
      'node_modules',
      '@img',
      'sharp-libvips-linux-x64',
      'package.json',
    ),
    '1.0.4',
  );

  for (const target of SHARP_TARGETS[platform] ?? []) {
    const dest = path.join(outDir, 'node_modules', '@img', target);
    if (fs.existsSync(dest)) continue;

    if (target.startsWith('sharp-libvips-')) {
      await fetchNpmPackage(`@img/${target}`, libvipsVersion, dest);
    } else {
      await fetchNpmPackage(`@img/${target}`, sharpVersion, dest);
      // darwin / linux 平台的 sharp 包依赖同平台的 libvips，一并补齐
      const suffix = target.replace('sharp-', '');
      const libvipsTarget = `sharp-libvips-${suffix}`;
      if (SHARP_TARGETS[platform].includes(libvipsTarget)) continue;
      const libvipsDest = path.join(outDir, 'node_modules', '@img', libvipsTarget);
      if (!fs.existsSync(libvipsDest) && suffix.startsWith('linux')) {
        await fetchNpmPackage(`@img/${libvipsTarget}`, libvipsVersion, libvipsDest);
      }
    }
  }
}

/* ---------------------------------------------------------------- */

async function prepareBase() {
  console.log('部署 @adh/server（pnpm deploy）');
  fs.rmSync(buildBase, { recursive: true, force: true });
  const deploy = runPnpm([
    '--filter',
    '@adh/server',
    'deploy',
    '--prod',
    // 扁平 node_modules：pnpm 的符号链接结构在复制/压缩后会断
    '--config.node-linker=hoisted',
    buildBase,
  ]);
  if (deploy.status !== 0) process.exit(deploy.status ?? 1);

  // 依赖已经平铺到顶层，虚拟目录只剩重复副本
  fs.rmSync(path.join(buildBase, 'node_modules', '.pnpm'), {
    recursive: true,
    force: true,
  });

  // pnpm deploy 会把仓库里既有的临时目录一起带进来
  for (const entry of fs.readdirSync(buildBase)) {
    if (entry === '.data' || entry === 'dist' || entry.startsWith('.deploy')) {
      fs.rmSync(path.join(buildBase, entry), { recursive: true, force: true });
    }
  }
  return buildBase;
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

  await prepareBase();
  await compileTypeScript(buildBase);
  fs.cpSync(publicDir, path.join(buildBase, 'public'), { recursive: true });

  const results = [];
  for (const platform of platforms) {
    const outDir = path.join(distDir, `server-${platform}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    console.log(`\n生成 ${platform} 包 → ${outDir}`);
    fs.cpSync(buildBase, outDir, { recursive: true });

    await injectSharp(outDir, platform);
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

  fs.rmSync(buildBase, { recursive: true, force: true });

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
