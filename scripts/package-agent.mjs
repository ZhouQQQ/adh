/**
 * 打一个可离线分发的 adh-agent 目录（可选再压成 zip）。
 *
 *   pnpm package:agent [--no-vendor] [--adb-url <url>] [--go-ios-url <url>]
 *
 * 默认把当前平台的 adb / go-ios 压缩包内置到 vendor/<platform>/，
 * 目标机器 init 时直接解压，不需要联网。
 *
 * 产物：dist/agent/ + dist/adh-agent-<platform>-<arch>.zip
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'dist', 'agent');
const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const skipVendor = args.includes('--no-vendor');
const adbUrlOverride =
  argValue('--adb-url') ?? process.env.ADH_PLATFORM_TOOLS_URL;
const goIosUrlOverride =
  argValue('--go-ios-url') ?? process.env.ADH_GO_IOS_URL;

const ADB_URLS = {
  win32: [
    'https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools-latest-windows.zip',
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  darwin: [
    'https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools-latest-darwin.zip',
    'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  ],
  linux: [
    'https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools-latest-linux.zip',
    'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
  ],
};

const GO_IOS_ASSETS = {
  win32: 'go-ios-win.zip',
  darwin: 'go-ios-mac.zip',
  linux: 'go-ios-linux.zip',
};

const vendorCache = path.join(root, '.data', 'agent-vendor', process.platform);

async function download(url, dest, label) {
  console.log(`下载 ${label}: ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'adh-agent-packager' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`${label} 下载失败（HTTP ${response.status}）`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(dest),
  );
}

async function resolveGoIosUrl() {
  if (goIosUrlOverride) return goIosUrlOverride;
  const release = await (
    await fetch('https://api.github.com/repos/danielpaulus/go-ios/releases/latest', {
      headers: { 'user-agent': 'adh-agent-packager', accept: 'application/vnd.github+json' },
    })
  ).json();
  const wanted = GO_IOS_ASSETS[process.platform];
  const asset = release.assets?.find((item) => item.name === wanted);
  if (!asset) throw new Error(`go-ios 最新 release 缺少 ${wanted}`);
  return asset.browser_download_url;
}

async function ensureVendorFile(name, urls, label) {
  fs.mkdirSync(vendorCache, { recursive: true });
  const dest = path.join(vendorCache, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`复用缓存 ${dest}`);
    return dest;
  }

  let lastError = null;
  for (const url of urls) {
    try {
      await download(url, dest, label);
      return dest;
    } catch (error) {
      lastError = error;
      console.warn(`  下载失败：${error instanceof Error ? error.message : error}`);
    }
  }
  throw lastError ?? new Error(`${label} 下载失败`);
}

async function fillVendor() {
  const target = path.join(outDir, 'vendor', process.platform);
  fs.mkdirSync(target, { recursive: true });

  const adbUrls = adbUrlOverride
    ? [adbUrlOverride]
    : ADB_URLS[process.platform] ?? [];
  if (adbUrls.length > 0) {
    const adb = await ensureVendorFile(
      'platform-tools.zip',
      adbUrls,
      'Android Platform Tools',
    );
    fs.copyFileSync(adb, path.join(target, 'platform-tools.zip'));
    console.log(
      `内置 adb: ${(fs.statSync(adb).size / 1024 / 1024).toFixed(1)} MB`,
    );
  }

  try {
    const url = await resolveGoIosUrl();
    const goIos = await ensureVendorFile('go-ios.zip', [url], 'go-ios');
    fs.copyFileSync(goIos, path.join(target, 'go-ios.zip'));
    console.log(
      `内置 go-ios: ${(fs.statSync(goIos).size / 1024 / 1024).toFixed(1)} MB`,
    );
  } catch (error) {
    console.warn(
      `  跳过 go-ios 内置：${error instanceof Error ? error.message : error}`,
    );
  }
}

fs.rmSync(outDir, { recursive: true, force: true });

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

if (skipVendor) {
  console.log('\n已跳过内置资源（--no-vendor），目标机 init 时会联网下载');
} else {
  console.log(`\n准备内置资源（${process.platform}）`);
  await fillVendor().catch((error) => {
    console.warn(
      `内置资源失败：${error instanceof Error ? error.message : error}\n目标机 init 时会尝试联网下载`,
    );
  });
}

if (process.platform !== 'win32') {
  fs.chmodSync(path.join(outDir, 'adh-agent.sh'), 0o755);
}

console.log(`\nadh-agent 已打包到 ${outDir}`);

if (isWindows) {
  const zipPath = path.join(
    root,
    'dist',
    `adh-agent-${process.platform}-${process.arch}.zip`,
  );
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
  2. adb 在 PATH 中（已随包内置，运行 adh-agent init 即可解压，无需联网）
     —— 如果系统里已有 adb / go-ios，可忽略 init
  3. 能访问 server 的 8080 端口

运行：
  adh-agent.cmd init                       # 解压内置的 adb / go-ios
  adh-agent.cmd connect --server ws://<server-ip>:8080 --key adh_xxx
`);