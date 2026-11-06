/**
 * 打包时下载 adb / go-ios 的公共逻辑，agent 和 server 的打包脚本共用。
 *
 * 下载结果缓存在 .data/<cacheDirName>/<platform>/，重复打包不会重复下载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const VENDOR_PLATFORMS = ['win32', 'darwin', 'linux'];

export const ADB_URLS = {
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

export const GO_IOS_ASSETS = {
  win32: 'go-ios-win.zip',
  darwin: 'go-ios-mac.zip',
  linux: 'go-ios-linux.zip',
};

/**
 * go-ios 的内核隧道在 Windows 上依赖 wintun.dll。
 *
 * wintun 官方包含 amd64 / arm64 / x86 三个架构，只有 750 KB 左右，
 * 打包时一起内置，agent init 会按当前架构放到 ios.exe 同目录
 * （go-ios 用 LOAD_LIBRARY_SEARCH_APPLICATION_DIR 加载，普通权限即可）。
 */
export const WINTUN_VERSION = '0.14.1';
export const WINTUN_URLS = [
  `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`,
];

export function createToolVendorResolver(options = {}) {
  const {
    root,
    userAgent = 'adh-packager',
    adbUrlOverride,
    goIosUrlOverride,
    wintunUrlOverride,
    cacheDirName = 'agent-vendor',
  } = options;
  if (!root) throw new Error('createToolVendorResolver 需要 root');

  const cacheRoot = path.join(root, '.data', cacheDirName);

  async function download(url, dest, label) {
    console.log(`  下载 ${label}: ${url}`);
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent },
    });
    if (!response.ok || !response.body) {
      throw new Error(`${label} 下载失败（HTTP ${response.status}）`);
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
  }

  async function ensureCached(platform, name, urls, label) {
    const cacheDir = path.join(cacheRoot, platform);
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
        console.warn(
          `  下载失败：${error instanceof Error ? error.message : error}`,
        );
      }
    }
    throw lastError ?? new Error(`${label} 下载失败`);
  }

  async function resolveGoIosUrlFor(platform) {
    if (goIosUrlOverride) return goIosUrlOverride;
    const wanted = GO_IOS_ASSETS[platform];
    try {
      const release = await (
        await fetch(
          'https://api.github.com/repos/danielpaulus/go-ios/releases/latest',
          {
            headers: {
              'user-agent': userAgent,
              accept: 'application/vnd.github+json',
            },
          },
        )
      ).json();
      const asset = release.assets?.find((item) => item.name === wanted);
      if (asset) return asset.browser_download_url;
    } catch {
      /* 速率限制或网络问题时走 latest/download 固定路径 */
    }
    return `https://github.com/danielpaulus/go-ios/releases/latest/download/${wanted}`;
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
      result.goIos = await ensureCached(
        platform,
        'go-ios.zip',
        [goIosUrl],
        'go-ios',
      );
    } catch (error) {
      console.warn(
        `  跳过 go-ios：${error instanceof Error ? error.message : error}`,
      );
    }

    // wintun.dll 只用于 Windows 的 iOS 内核隧道；放不进目标机 system32 时，
    // 也可以和 ios.exe 放同一目录（go-ios 会优先从 application dir 加载）。
    if (platform === 'win32') {
      const wintunUrls = wintunUrlOverride ? [wintunUrlOverride] : WINTUN_URLS;
      try {
        result.wintun = await ensureCached(
          platform,
          'wintun.zip',
          wintunUrls,
          'wintun',
        );
      } catch (error) {
        console.warn(
          `  跳过 wintun：${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return result;
  }

  return { acquireVendor, resolveGoIosUrlFor };
}