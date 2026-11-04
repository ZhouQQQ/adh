import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from '@adh/device-host';

/** 自动下载的工具放在 ~/.adh/tools 下，不污染系统 PATH。 */
export const TOOLS_DIR = path.join(os.homedir(), '.adh', 'tools');

/** 打包时按平台放进去的内置资源（解压后无需联网）。 */
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor', process.platform);

export function platformToolsDir(): string {
  return path.join(TOOLS_DIR, 'platform-tools');
}

export function goIosDir(): string {
  return path.join(TOOLS_DIR, 'go-ios');
}

function adbBinary(): string {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

/**
 * 把自动下载的工具目录前置到当前进程的 PATH。
 * agent 的 adb / go-ios 子进程会继承，无需改用户系统环境变量。
 */
export function ensureToolPath(): string[] {
  const dirs = [platformToolsDir(), goIosDir()].filter((dir) =>
    fs.existsSync(dir),
  );
  if (dirs.length === 0) return [];

  const parts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const missing = dirs.filter((dir) => !parts.includes(dir));
  if (missing.length > 0) {
    process.env.PATH = [...missing, ...parts].join(path.delimiter);
  }
  return dirs;
}

export interface InitOptions {
  skipAndroid?: boolean;
  skipIos?: boolean;
  force?: boolean;
}

const PLATFORM_TOOLS_URLS: Record<string, string[]> = {
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

const GO_IOS_ASSET: Record<string, string> = {
  win32: 'go-ios-win.zip',
  darwin: 'go-ios-mac.zip',
  linux: 'go-ios-linux.zip',
};

async function download(url: string, dest: string, label: string): Promise<void> {
  console.log(`  下载 ${label}: ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'adh-agent' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`${label} 下载失败（HTTP ${response.status}）`);
  }
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(dest));
}

function extract(zipPath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(targetDir, true);
}

/** 在目录里递归找可执行文件，兼容压缩包内多一层目录。 */
function findBinary(dir: string, names: string[]): string | null {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (names.includes(entry.name)) return full;
    }
  }
  return null;
}

function makeExecutable(file: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* 忽略权限错误 */
  }
}

async function installAndroidTools(force: boolean): Promise<boolean> {
  if (!force && fs.existsSync(path.join(platformToolsDir(), adbBinary()))) {
    console.log('  adb 已存在，跳过（用 --force 可重新安装）');
    return true;
  }

  const installFromZip = (zipPath: string): boolean => {
    fs.rmSync(platformToolsDir(), { recursive: true, force: true });
    // 官方 zip 里就是 platform-tools/ 目录
    extract(zipPath, TOOLS_DIR);
    makeExecutable(path.join(platformToolsDir(), adbBinary()));
    console.log(`  adb 安装到 ${platformToolsDir()}`);
    return true;
  };

  const bundled = path.join(VENDOR_DIR, 'platform-tools.zip');
  if (fs.existsSync(bundled)) {
    console.log('  使用安装包内置的 adb（无需联网）');
    try {
      return installFromZip(bundled);
    } catch (error) {
      console.warn(
        `  内置 adb 解压失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const urls = PLATFORM_TOOLS_URLS[process.platform];
  if (!urls) {
    console.warn(`  当前系统 ${process.platform} 没有预置的 Platform Tools 下载地址`);
    return false;
  }

  const tempZip = path.join(os.tmpdir(), `adh-platform-tools-${Date.now()}.zip`);
  try {
    let lastError: unknown = null;
    for (const url of urls) {
      try {
        await download(url, tempZip, 'Android Platform Tools');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `  镜像不可用：${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (lastError) throw lastError;
    return installFromZip(tempZip);
  } catch (error) {
    console.warn(`  adb 自动安装失败：${error instanceof Error ? error.message : error}`);
    console.warn('  请手动下载：https://developer.android.com/studio/releases/platform-tools');
    return false;
  } finally {
    fs.rmSync(tempZip, { force: true });
  }
}

/** go-ios 的 release 里可执行文件叫 ios（Windows 为 ios.exe）。 */
const GO_IOS_BINARIES = ['go-ios.exe', 'go-ios', 'ios.exe', 'ios'];

async function installGoIos(): Promise<boolean> {
  const existing = findBinary(goIosDir(), GO_IOS_BINARIES);
  if (existing) {
    console.log(`  go-ios 已存在，跳过：${existing}`);
    return true;
  }

  const installFromZip = (zipPath: string): boolean => {
    fs.rmSync(goIosDir(), { recursive: true, force: true });
    extract(zipPath, goIosDir());
    const binary = findBinary(goIosDir(), GO_IOS_BINARIES);
    if (binary) makeExecutable(binary);
    console.log(`  go-ios 安装到 ${goIosDir()}`);
    return true;
  };

  const bundled = path.join(VENDOR_DIR, 'go-ios.zip');
  if (fs.existsSync(bundled)) {
    console.log('  使用安装包内置的 go-ios（无需联网）');
    try {
      return installFromZip(bundled);
    } catch (error) {
      console.warn(
        `  内置 go-ios 解压失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  try {
    let url = process.env.ADH_GO_IOS_URL?.trim();
    if (!url) {
      const release = (await (
        await fetch('https://api.github.com/repos/danielpaulus/go-ios/releases/latest', {
          headers: { 'user-agent': 'adh-agent', accept: 'application/vnd.github+json' },
        })
      ).json()) as { assets?: { name: string; browser_download_url: string }[] };

      const wanted = GO_IOS_ASSET[process.platform];
      url = release.assets?.find((item) => item.name === wanted)?.browser_download_url;
      if (!url) {
        throw new Error(`最新 release 里没有 ${wanted ?? '当前平台'} 的包`);
      }
    }

    const tempZip = path.join(os.tmpdir(), `adh-go-ios-${Date.now()}.zip`);
    try {
      await download(url, tempZip, 'go-ios');
      return installFromZip(tempZip);
    } finally {
      fs.rmSync(tempZip, { force: true });
    }
  } catch (error) {
    console.warn(`  go-ios 自动安装失败：${error instanceof Error ? error.message : error}`);
    console.warn('  可选：手动下载 https://github.com/danielpaulus/go-ios/releases');
    return false;
  }
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  console.log(`\nadh-agent init · ${process.platform} / ${process.arch}`);
  console.log(`工具目录：${TOOLS_DIR}`);
  console.log(
    `资源来源：${fs.existsSync(VENDOR_DIR) ? '安装包内置（无需联网）' : '联网下载'}\n`,
  );

  console.log('[1/2] Android Platform Tools');
  if (options.skipAndroid) {
    console.log('  已跳过（--skip-android）');
  } else {
    await installAndroidTools(Boolean(options.force));
  }

  console.log('\n[2/2] go-ios（iOS 设备发现，可选）');
  if (options.skipIos) {
    console.log('  已跳过（--skip-ios）');
  } else {
    await installGoIos();
  }

  ensureToolPath();

  console.log('\n环境检查：');
  const adb = await checkCommand('adb', ['version']);
  // go-ios 的可执行文件在 Windows / macOS 上通常叫 ios.exe / ios，
  // 只认 `go-ios` 会误报「不可用」
  const goIos =
    (await checkCommand('ios', ['version'])) ??
    (await checkCommand('go-ios', ['version']));
  console.log(`  adb    ${adb ?? '不可用'}`);
  console.log(`  go-ios ${goIos ?? '不可用（不影响 Android）'}`);

  console.log('\n下一步：');
  console.log('  adh-agent connect --server ws://<server-ip>:8080 --key adh_xxx\n');
}

async function checkCommand(command: string, args: string[]): Promise<string | null> {
  const result = await runCommand(command, args, 8_000);
  if (result.failedToStart) return null;
  const line = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? '';
  return line || '已安装';
}