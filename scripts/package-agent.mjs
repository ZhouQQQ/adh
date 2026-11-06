/**
 * 打可离线分发的 adh-agent 安装包。
 *
 *   pnpm package:agent                    # 默认构建 win32 / darwin / linux 三个平台
 *   pnpm package:agent --platform win32   # 只构建指定平台（可逗号分隔）
 *   pnpm package:agent --no-vendor        # 不内置 adb / go-ios，目标机 init 时联网
 *
 * 每个平台各自产出：
 *   dist/adh-agent-<platform>-v<version>/  自包含目录
 *   dist/adh-agent-<platform>.zip         Web 控制台下载的就是它（内部根目录带版本号）
 *
 * agent 依赖（含 jimp）是纯 JS，平台差异只来自内置的 adb / go-ios 压缩包，
 * 所以同一份 deploy 结果可以复用，按平台塞入不同 vendor 即可。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createToolVendorResolver } from './vendor-tools.mjs';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const buildBase = path.join(root, '.data', 'agent-build', 'base');
const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);

const ALL_PLATFORMS = ['win32', 'darwin', 'linux'];

/**
 * 包内文件夹与运行版本统一用同一个版本号，例如 adh-agent-win32-v0.1.7。
 * 优先 ADH_AGENT_VERSION，其次 CI 的 tag（GITHUB_REF_NAME=v0.1.7），
 * 然后本地最近的 v* tag，最后回退到 apps/agent/package.json 的 version。
 * 只用 semver 形式的 tag，避免 git describe 的 v0.1.7-3-gabc 弄乱版本比较。
 */
function resolveAgentVersion() {
  const explicit = process.env.ADH_AGENT_VERSION?.trim();
  if (explicit) return explicit.replace(/^v/, '');
  const ref = process.env.GITHUB_REF_NAME?.trim();
  if (ref && /^v?\d+(\.\d+)*$/.test(ref)) return ref.replace(/^v/, '');
  try {
    const tag = spawnSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'],
      { cwd: root, encoding: 'utf8' },
    );
    const value = tag.status === 0 ? tag.stdout.trim() : '';
    if (/^v?\d+(\.\d+)*$/.test(value)) return value.replace(/^v/, '');
  } catch {
    /* 没有 git 时用 package.json */
  }
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'apps/agent/package.json'), 'utf8'),
    );
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const AGENT_VERSION = resolveAgentVersion();

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePlatforms(raw) {
  if (!raw || raw === 'all') return ALL_PLATFORMS;
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = list.filter((item) => !ALL_PLATFORMS.includes(item));
  if (invalid.length > 0) {
    console.error(`不支持的平台：${invalid.join(', ')}（可选：${ALL_PLATFORMS.join(', ')}）`);
    process.exit(1);
  }
  return [...new Set(list)];
}

const platforms = parsePlatforms(argValue('--platform'));
const skipVendor = args.includes('--no-vendor');
const adbUrlOverride =
  argValue('--adb-url') ?? process.env.ADH_PLATFORM_TOOLS_URL;
const goIosUrlOverride =
  argValue('--go-ios-url') ?? process.env.ADH_GO_IOS_URL;
const wintunUrlOverride =
  argValue('--wintun-url') ?? process.env.ADH_WINTUN_URL;

const { acquireVendor } = createToolVendorResolver({
  root,
  userAgent: 'adh-agent-packager',
  adbUrlOverride,
  goIosUrlOverride,
  wintunUrlOverride,
  cacheDirName: 'agent-vendor',
});

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

/** 流式计算 sha256，避免把上百 MB 的安装包整个读进内存。 */
function sha256OfFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function zipDir(dir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (isWindows) {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}' -DestinationPath '${zipPath}' -Force`],
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

/** 把版本号写进启动脚本，agent 启动日志会打印出来。 */
function injectVersion(base, version) {
  const cmdPath = path.join(base, 'adh-agent.cmd');
  if (fs.existsSync(cmdPath)) {
    const text = fs.readFileSync(cmdPath, 'utf8');
    if (!text.includes('ADH_VERSION')) {
      fs.writeFileSync(
        cmdPath,
        text.replace(
          /^(@echo off\r?\n)/i,
          `$1if "%ADH_VERSION%"=="" set "ADH_VERSION=${version}"\r\n`,
        ),
      );
    }
  }

  const shPath = path.join(base, 'adh-agent.sh');
  if (fs.existsSync(shPath)) {
    const text = fs.readFileSync(shPath, 'utf8');
    if (!text.includes('ADH_VERSION')) {
      fs.writeFileSync(
        shPath,
        text.replace(
          /^(#!.*\n)/,
          `$1export ADH_VERSION="\${ADH_VERSION:-${version}}"\n`,
        ),
      );
    }
  }
}

async function prepareBase() {
  console.log('打包基础目录（pnpm deploy）');
  fs.rmSync(buildBase, { recursive: true, force: true });
  const deploy = runPnpm([
    '--filter',
    '@adh/agent',
    'deploy',
    '--prod',
    // 扁平 node_modules：pnpm 默认的符号链接结构在复制/压缩后会断，跨平台复用时更明显
    '--config.node-linker=hoisted',
    buildBase,
  ]);
  if (deploy.status !== 0) process.exit(deploy.status ?? 1);

  // 依赖已经全部平铺到顶层，虚拟目录只剩重复副本
  fs.rmSync(path.join(buildBase, 'node_modules', '.pnpm'), {
    recursive: true,
    force: true,
  });

  // pnpm deploy 可能把仓库里既有的打包产物目录一起带进来
  for (const stray of ['.data', 'dist']) {
    fs.rmSync(path.join(buildBase, stray), { recursive: true, force: true });
  }
  const version = AGENT_VERSION;
  injectVersion(buildBase, version);
  console.log(`  版本号: ${version}`);
  if (!isWindows) {
    fs.chmodSync(path.join(buildBase, 'adh-agent.sh'), 0o755);
  }
  return buildBase;
}

/** 递归列出目录里的 .ts 源文件（排除 .d.ts）。 */
function listTsFiles(dir) {
  const result = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
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
  for (const [key, value] of Object.entries(patch)) {
    pkg[key] = value;
  }
  // pnpm 的包文件可能是硬链接，先断开再写，否则会改到仓库里的源码
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** 删除包本体与 pnpm 虚拟目录里的副本，同时清理 .bin 残余链接。 */
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

  const binDir = path.join(base, 'node_modules', '.bin');
  if (fs.existsSync(binDir)) {
    for (const entry of fs.readdirSync(binDir)) {
      if (entry.startsWith(name.replace('@', '').split('/')[0])) {
        fs.rmSync(path.join(binDir, entry), { force: true });
      }
    }
  }
}

/**
 * pnpm 的 file: 依赖可能是指向仓库源码的符号链接，
 * 直接改写会污染源码，先复制成实体目录再处理。
 */
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

/**
 * 把 TypeScript 就地编译成 JS。
 *
 * 保持目录结构（不做 bundle）：device-host 用 import.meta.url 定位
 * scrcpy-server.jar，agent 用它定位 vendor/，打包成单文件会破坏这些路径。
 * 编译后产物只含纯 JS，三个平台可以共用同一份，不再需要 macOS/Windows runner。
 */
async function compileTypeScript(base, version) {
  console.log('编译 TypeScript（产物不再依赖 tsx / esbuild）');

  // 防止 deploy 产物里的 workspace 包还是符号链接（会把改动写回仓库）
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
      // deploy 目录里没有 tsconfig.base.json，直接用命令行参数，避免解析警告
      tsconfigRaw: {},
    });
    for (const file of files) fs.rmSync(file, { force: true });
  }

  patchPackageJson(path.join(base, 'package.json'), {
    main: './src/cli.js',
    // 自更新需要从安装包内读版本，package.json 必须和 ADH_VERSION 一致
    version,
  });
  for (const name of ['protocol', 'device-host']) {
    patchPackageJson(
      path.join(base, 'node_modules', '@adh', name, 'package.json'),
      { exports: { '.': { default: './src/index.js' } } },
    );
  }

  // 运行时用不到，而且 esbuild 自带平台二进制，删掉才能三平台共用一个包
  removePackage(base, 'tsx', 'tsx@');
  removePackage(base, 'esbuild', 'esbuild@');
  removePackage(base, '@esbuild', '@esbuild+');

  stripTypeScriptSources(base);
}

/** 第三方包自带的 TS 源码（如 jimp）运行时用不到，删掉减小体积。 */
function stripTypeScriptSources(base) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        fs.rmSync(full, { force: true });
      }
    }
  };
  walk(path.join(base, 'node_modules'));
}

/** 打包后自检：确认是编译产物、没有被平台限制的依赖，当前平台还能跑起来。 */
function selfCheck(dir, platform) {
  const required = [
    'src/cli.js',
    'node_modules/@adh/protocol/src/index.js',
    'node_modules/@adh/device-host/src/index.js',
    'node_modules/@adh/device-host/resources/scrcpy-server.jar',
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(dir, rel))) {
      throw new Error(`产物缺少 ${rel}`);
    }
  }
  for (const forbidden of ['tsx', 'esbuild', '@esbuild']) {
    if (fs.existsSync(path.join(dir, 'node_modules', forbidden))) {
      throw new Error(`产物仍包含 ${forbidden}，无法跨平台使用`);
    }
  }

  if (platform === process.platform) {
    const check = spawnSync(process.execPath, [path.join(dir, 'src', 'cli.js'), 'version'], {
      stdio: 'inherit',
    });
    if (check.status !== 0) {
      throw new Error('自检运行失败');
    }
  }
}

async function main() {
  fs.mkdirSync(distDir, { recursive: true });
  await prepareBase();
  await compileTypeScript(buildBase, AGENT_VERSION);

  const results = [];

  for (const platform of platforms) {
    console.log(`\n构建 ${platform}`);
    const outDir = path.join(
      distDir,
      `adh-agent-${platform}-v${AGENT_VERSION}`,
    );
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.cpSync(buildBase, outDir, { recursive: true });

    if (!skipVendor) {
      try {
        const vendor = await acquireVendor(platform);
        const vendorDir = path.join(outDir, 'vendor', platform);
        fs.mkdirSync(vendorDir, { recursive: true });
        if (vendor.adb) {
          fs.copyFileSync(vendor.adb, path.join(vendorDir, 'platform-tools.zip'));
          console.log(
            `  内置 adb: ${(fs.statSync(vendor.adb).size / 1024 / 1024).toFixed(1)} MB`,
          );
        }
        if (vendor.goIos) {
          fs.copyFileSync(vendor.goIos, path.join(vendorDir, 'go-ios.zip'));
          console.log(
            `  内置 go-ios: ${(fs.statSync(vendor.goIos).size / 1024 / 1024).toFixed(1)} MB`,
          );
        }
        if (vendor.wintun) {
          fs.copyFileSync(vendor.wintun, path.join(vendorDir, 'wintun.zip'));
          console.log(
            `  内置 wintun: ${(fs.statSync(vendor.wintun).size / 1024).toFixed(0)} KB`,
          );
        }
      } catch (error) {
        console.warn(
          `  内置资源失败：${error instanceof Error ? error.message : error}（目标机 init 时会联网下载）`,
        );
      }
    }

    const zipPath = path.join(distDir, `adh-agent-${platform}.zip`);
    selfCheck(outDir, platform);
    const zipped = zipDir(outDir, zipPath);
    const size = zipped ? fs.statSync(zipPath).size : 0;
    results.push({
      platform,
      dir: outDir,
      zip: zipped ? zipPath : null,
      size,
      sha256: zipped ? sha256OfFile(zipPath) : null,
    });
    console.log(`  ${zipped ? `已生成 ${zipPath}` : '未生成 zip'}`);
  }

  console.log('\n构建完成：');
  for (const item of results) {
    const size = item.size ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : '—';
    console.log(`  ${item.platform.padEnd(7)} ${size.padStart(8)}  ${item.zip ?? item.dir}`);
  }

  // 自更新清单：agent 通过它比较版本、下载对应平台安装包并校验 sha256。
  const manifestPath = path.join(distDir, 'adh-agent-manifest.json');
  const manifest = {
    version: AGENT_VERSION,
    releasedAt: new Date().toISOString(),
    minNode: '22.13.0',
    platforms: Object.fromEntries(
      results
        .filter((item) => item.zip)
        .map((item) => [
          item.platform,
          {
            file: path.basename(item.zip),
            size: item.size,
            sha256: item.sha256,
          },
        ]),
    ),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`版本清单: ${manifestPath}`);

  console.log(`
目标机器只需要：
  1. Node.js 22+（https://nodejs.org）
  2. adb / go-ios：安装包已内置，首次 connect 自动离线解压（也可提前运行 adh-agent init）
  3. 能访问 server 的 8080 端口

运行：
  adh-agent.cmd connect --server ws://<server-ip>:8080 --key adh_xxx
`);
}

await main();