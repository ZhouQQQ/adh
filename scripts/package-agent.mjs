/**
 * 打可离线分发的 adh-agent 安装包。
 *
 *   pnpm package:agent                    # 默认构建 win32 / darwin / linux 三个平台
 *   pnpm package:agent --platform win32   # 只构建指定平台（可逗号分隔）
 *   pnpm package:agent --no-vendor        # 不内置 adb / go-ios，目标机 init 时联网
 *
 * 每个平台各自产出：
 *   dist/agent-<platform>/               自包含目录
 *   dist/adh-agent-<platform>.zip        Web 控制台下载的就是它
 *
 * agent 依赖（含 jimp）是纯 JS，平台差异只来自内置的 adb / go-ios 压缩包，
 * 所以同一份 deploy 结果可以复用，按平台塞入不同 vendor 即可。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const buildBase = path.join(root, '.data', 'agent-build', 'base');
const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);

const ALL_PLATFORMS = ['win32', 'darwin'];

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

async function download(url, dest, label) {
  console.log(`  下载 ${label}: ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'adh-agent-packager' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`${label} 下载失败（HTTP ${response.status}）`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
}

async function ensureCached(platform, name, urls, label) {
  const cacheDir = path.join(root, '.data', 'agent-vendor', platform);
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  复用缓存 ${dest}`);
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

async function acquireVendor(platform) {
  const adbUrls = adbUrlOverride ? [adbUrlOverride] : ADB_URLS[platform] ?? [];
  const result = {};

  if (adbUrls.length > 0) {
    result.adb = await ensureCached(
      platform,
      'platform-tools.zip',
      adbUrls,
      'Android Platform Tools',
    );
  }

  try {
    const goIosUrl = await resolveGoIosUrlFor(platform);
    result.goIos = await ensureCached(platform, 'go-ios.zip', [goIosUrl], 'go-ios');
  } catch (error) {
    console.warn(`  跳过 go-ios：${error instanceof Error ? error.message : error}`);
  }

  return result;
}

async function resolveGoIosUrlFor(platform) {
  if (goIosUrlOverride) return goIosUrlOverride;
  const wanted = GO_IOS_ASSETS[platform];
  try {
    const release = await (
      await fetch('https://api.github.com/repos/danielpaulus/go-ios/releases/latest', {
        headers: {
          'user-agent': 'adh-agent-packager',
          accept: 'application/vnd.github+json',
        },
      })
    ).json();
    const asset = release.assets?.find((item) => item.name === wanted);
    if (asset) return asset.browser_download_url;
  } catch {
    /* 速率限制或网络问题时走 latest/download 固定路径 */
  }
  return `https://github.com/danielpaulus/go-ios/releases/latest/download/${wanted}`;
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

async function prepareBase() {
  console.log('打包基础目录（pnpm deploy）');
  fs.rmSync(buildBase, { recursive: true, force: true });
  const deploy = runPnpm(['--filter', '@adh/agent', 'deploy', '--prod', buildBase]);
  if (deploy.status !== 0) process.exit(deploy.status ?? 1);

  // pnpm deploy 可能把仓库里既有的打包产物目录一起带进来
  for (const stray of ['.data', 'dist']) {
    fs.rmSync(path.join(buildBase, stray), { recursive: true, force: true });
  }
  if (!isWindows) {
    fs.chmodSync(path.join(buildBase, 'adh-agent.sh'), 0o755);
  }
  return buildBase;
}

async function main() {
  fs.mkdirSync(distDir, { recursive: true });
  await prepareBase();

  const results = [];

  for (const platform of platforms) {
    console.log(`\n构建 ${platform}`);
    const outDir = path.join(distDir, `agent-${platform}`);
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
      } catch (error) {
        console.warn(
          `  内置资源失败：${error instanceof Error ? error.message : error}（目标机 init 时会联网下载）`,
        );
      }
    }

    const zipPath = path.join(distDir, `adh-agent-${platform}.zip`);
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
目标机器只需要：
  1. Node.js 22+（https://nodejs.org）
  2. adb / go-ios：安装包已内置，运行 adh-agent init 离线解压（系统已有可忽略）
  3. 能访问 server 的 8080 端口

运行：
  adh-agent.cmd init
  adh-agent.cmd connect --server ws://<server-ip>:8080 --key adh_xxx
`);
}

await main();