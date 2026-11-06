import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentCapability } from '@adh/protocol';
import { runCommand } from './exec.js';

/**
 * adb / go-ios 的安装与探测（server 内置 Agent 和外接 Agent 共用）。
 *
 * 工具统一装在 ~/.adh/tools，不污染系统 PATH；下载源按当前平台自动选择。
 * 打包版 agent 可以用 vendorDir 指定内置资源目录，离线解压。
 */
export const TOOLS_DIR = path.join(os.homedir(), '.adh', 'tools');

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
 * adb / go-ios 子进程会继承，无需改用户系统环境变量。
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

export type ToolLog = (line: string) => void;

export interface ToolInstallOptions {
  force?: boolean;
  /** 打包版 agent 的内置工具目录（vendor/<platform>）。 */
  vendorDir?: string;
  log?: ToolLog;
}

export interface ToolInstallResult {
  ok: boolean;
  /** 安装后的可执行文件路径。 */
  path?: string;
  /** 已经存在时跳过。 */
  skipped?: boolean;
  error?: string;
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

/** go-ios 的 release 里可执行文件叫 ios（Windows 为 ios.exe）。 */
const GO_IOS_BINARIES = ['go-ios.exe', 'go-ios', 'ios.exe', 'ios'];

const WINTUN_VERSION = '0.14.1';
const WINTUN_URL = `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`;

/** 运行时架构对应的 wintun.dll 在官方 zip 里的路径。 */
const WINTUN_ARCH_DIR: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
  ia32: 'x86',
};

async function download(
  url: string,
  dest: string,
  label: string,
  log?: ToolLog,
): Promise<void> {
  log?.(`下载 ${label}: ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'adh-agent' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`${label} 下载失败（HTTP ${response.status}）`);
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    fs.createWriteStream(dest),
  );
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

/** 已安装到 ~/.adh/tools/go-ios 的 go-ios 可执行文件。 */
export function managedGoIosBinary(): string | null {
  return findBinary(goIosDir(), GO_IOS_BINARIES);
}

function readWintunDll(zipPath: string): Buffer {
  const arch = WINTUN_ARCH_DIR[process.arch];
  if (!arch) {
    throw new Error(`当前架构 ${process.arch} 没有对应的 wintun.dll`);
  }
  const entry = new AdmZip(zipPath).getEntry(`wintun/bin/${arch}/wintun.dll`);
  if (!entry) {
    throw new Error(`wintun 包里没有 wintun/bin/${arch}/wintun.dll`);
  }
  return entry.getData();
}

export interface WintunInstallOptions {
  /** 打包版内置资源目录（vendor/<platform>），里面有 wintun.zip。 */
  vendorDir?: string;
  log?: ToolLog;
  /** 没有内置包时是否允许联网下载；启动自检时传 false，避免阻塞。 */
  allowDownload?: boolean;
}

/**
 * Windows：把 wintun.dll 放到 go-ios 可执行文件同目录。
 *
 * go-ios 的 wintun 绑定用
 * `LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`
 * 加载，会优先搜索 exe 所在目录，所以普通用户权限即可完成安装，
 * 不必写 `C:\Windows\System32`。其它平台直接返回 true。
 */
export async function ensureWintunDll(
  goIosBinary: string,
  options: WintunInstallOptions = {},
): Promise<boolean> {
  if (process.platform !== 'win32') return true;

  const dir = path.dirname(goIosBinary);
  const target = path.join(dir, 'wintun.dll');
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return true;

  try {
    let data: Buffer;
    const bundled = options.vendorDir
      ? path.join(options.vendorDir, 'wintun.zip')
      : null;

    if (bundled && fs.existsSync(bundled)) {
      options.log?.('使用安装包内置的 wintun.dll（无需联网）');
      data = readWintunDll(bundled);
    } else if (options.allowDownload === false) {
      options.log?.(
        'wintun.dll 未找到：iOS 内核隧道会自动回退 --userspace；运行 adh-agent init 可补齐',
      );
      return false;
    } else {
      const tempZip = path.join(os.tmpdir(), `adh-wintun-${Date.now()}.zip`);
      try {
        await download(
          process.env.ADH_WINTUN_URL?.trim() || WINTUN_URL,
          tempZip,
          'wintun.dll',
          options.log,
        );
        data = readWintunDll(tempZip);
      } finally {
        fs.rmSync(tempZip, { force: true });
      }
    }

    try {
      fs.writeFileSync(target, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(
        `wintun.dll 写入 ${dir} 失败：${message}；可手动复制到该目录，或改用 --userspace`,
      );
      return false;
    }

    options.log?.(`wintun.dll 已安装到 ${dir}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(
      `wintun.dll 安装失败：${message}（iOS 内核隧道会自动回退 --userspace）`,
    );
    return false;
  }
}

/** 安装 Android Platform Tools（adb）。已存在时默认跳过。 */
export async function installAndroidTools(
  options: ToolInstallOptions = {},
): Promise<ToolInstallResult> {
  const adbPath = path.join(platformToolsDir(), adbBinary());
  if (!options.force && fs.existsSync(adbPath)) {
    options.log?.('adb 已存在，跳过（可强制重新安装）');
    return { ok: true, path: adbPath, skipped: true };
  }

  const installFromZip = (zipPath: string): ToolInstallResult => {
    try {
      fs.rmSync(platformToolsDir(), { recursive: true, force: true });
      // 官方 zip 里就是 platform-tools/ 目录
      extract(zipPath, TOOLS_DIR);
      makeExecutable(adbPath);
      options.log?.(`adb 安装到 ${platformToolsDir()}`);
      return { ok: true, path: adbPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`内置 adb 解压失败：${message}`);
      return { ok: false, error: message };
    }
  };

  const bundled = options.vendorDir
    ? path.join(options.vendorDir, 'platform-tools.zip')
    : null;
  if (bundled && fs.existsSync(bundled)) {
    options.log?.('使用安装包内置的 adb（无需联网）');
    const result = installFromZip(bundled);
    if (result.ok) return result;
  }

  const urls = PLATFORM_TOOLS_URLS[process.platform];
  if (!urls) {
    return {
      ok: false,
      error: `当前系统 ${process.platform} 没有预置的 Platform Tools 下载地址`,
    };
  }

  const tempZip = path.join(os.tmpdir(), `adh-platform-tools-${Date.now()}.zip`);
  try {
    let lastError: unknown = null;
    for (const url of urls) {
      try {
        await download(url, tempZip, 'Android Platform Tools', options.log);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        options.log?.(
          `镜像不可用：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (lastError) throw lastError;
    return installFromZip(tempZip);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`adb 自动安装失败：${message}`);
    return { ok: false, error: message };
  } finally {
    fs.rmSync(tempZip, { force: true });
  }
}

/** 安装 go-ios（iOS 设备发现 / WDA / 隧道依赖）。已存在时默认跳过。 */
export async function installGoIos(
  options: ToolInstallOptions = {},
): Promise<ToolInstallResult> {
  const existing = managedGoIosBinary();
  if (existing) {
    options.log?.(`go-ios 已存在，跳过：${existing}`);
    // 老版本安装目录可能没有 wintun.dll，启动时顺手补齐（已存在会直接返回）
    await ensureWintunDll(existing, options);
    return { ok: true, path: existing, skipped: true };
  }

  const installFromZip = (zipPath: string): ToolInstallResult => {
    try {
      fs.rmSync(goIosDir(), { recursive: true, force: true });
      extract(zipPath, goIosDir());
      const binary = findBinary(goIosDir(), GO_IOS_BINARIES);
      if (binary) makeExecutable(binary);
      options.log?.(`go-ios 安装到 ${goIosDir()}`);
      return binary
        ? { ok: true, path: binary }
        : { ok: false, error: '压缩包里没有找到 go-ios 可执行文件' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`内置 go-ios 解压失败：${message}`);
      return { ok: false, error: message };
    }
  };

  // Windows 上 go-ios 还依赖 wintun.dll，和可执行文件放同一目录即可
  const finish = async (
    result: ToolInstallResult,
  ): Promise<ToolInstallResult> => {
    if (result.ok && result.path) {
      await ensureWintunDll(result.path, options);
    }
    return result;
  };

  const bundled = options.vendorDir
    ? path.join(options.vendorDir, 'go-ios.zip')
    : null;
  if (bundled && fs.existsSync(bundled)) {
    options.log?.('使用安装包内置的 go-ios（无需联网）');
    const result = installFromZip(bundled);
    if (result.ok) return finish(result);
  }

  try {
    let url = process.env.ADH_GO_IOS_URL?.trim();
    if (!url) {
      const release = (await (
        await fetch('https://api.github.com/repos/danielpaulus/go-ios/releases/latest', {
          headers: {
            'user-agent': 'adh-agent',
            accept: 'application/vnd.github+json',
          },
        })
      ).json()) as {
        assets?: { name: string; browser_download_url: string }[];
      };

      const wanted = GO_IOS_ASSET[process.platform];
      url = release.assets?.find((item) => item.name === wanted)
        ?.browser_download_url;
      if (!url) {
        throw new Error(`最新 release 里没有 ${wanted ?? '当前平台'} 的包`);
      }
    }

    const tempZip = path.join(os.tmpdir(), `adh-go-ios-${Date.now()}.zip`);
    try {
      await download(url, tempZip, 'go-ios', options.log);
      return finish(installFromZip(tempZip));
    } finally {
      fs.rmSync(tempZip, { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`go-ios 自动安装失败：${message}`);
    return { ok: false, error: message };
  }
}

/** 执行 `cmd version`，返回首行输出；未安装时返回 null。 */
export async function probeCommandVersion(
  command: string,
  args: string[] = ['version'],
): Promise<string | null> {
  const result = await runCommand(command, args, 8_000);
  if (result.failedToStart) return null;
  const line = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? '';
  return line || '已安装';
}

/**
 * 启动时使用安装包内置的工具包（vendor/<platform>/）。
 * 系统或 ~/.adh/tools 已有对应工具就跳过；没有则离线解压，不请求网络。
 */
export async function ensureBundledTools(
  vendorDir?: string,
  log?: ToolLog,
): Promise<void> {
  ensureToolPath();
  if (!vendorDir || !fs.existsSync(vendorDir)) return;

  const adb = await probeCommandVersion('adb', ['version']);
  if (!adb && fs.existsSync(path.join(vendorDir, 'platform-tools.zip'))) {
    log?.('从安装包解压 adb…');
    await installAndroidTools({ vendorDir, log });
  }

  const goIos =
    (await probeCommandVersion('ios')) ??
    (await probeCommandVersion('go-ios'));
  if (!goIos && fs.existsSync(path.join(vendorDir, 'go-ios.zip'))) {
    log?.('从安装包解压 go-ios…');
    await installGoIos({ vendorDir, log });
  }

  // 已经装过 go-ios（旧版本没有 wintun.dll）时补齐，只读本地内置包，不联网
  const managed = managedGoIosBinary();
  if (managed && process.platform === 'win32') {
    await ensureWintunDll(managed, { vendorDir, log, allowDownload: false });
  }

  ensureToolPath();
}

/** 安装后按当前节点实际可用的工具计算能力：有 adb = android，有 go-ios = ios。 */
export async function detectAgentCapabilities(): Promise<AgentCapability[]> {
  ensureToolPath();
  const adb = await probeCommandVersion('adb', ['version']);
  const goIos =
    (await probeCommandVersion('ios')) ??
    (await probeCommandVersion('go-ios'));

  const capabilities: AgentCapability[] = [];
  if (adb) capabilities.push('android');
  if (goIos) capabilities.push('ios');
  return capabilities;
}

export interface InstallToolsRequest {
  android?: boolean;
  ios?: boolean;
  force?: boolean;
  vendorDir?: string;
  log?: ToolLog;
}

export interface InstallToolsResult {
  ok: boolean;
  capabilities: AgentCapability[];
  android?: ToolInstallResult;
  ios?: ToolInstallResult;
}

/** 按请求安装 adb / go-ios，并返回安装后的能力列表。 */
export async function installAgentTools(
  request: InstallToolsRequest = {},
): Promise<InstallToolsResult> {
  const android = request.android
    ? await installAndroidTools({
        force: request.force,
        vendorDir: request.vendorDir,
        log: request.log,
      })
    : undefined;
  const ios = request.ios
    ? await installGoIos({
        force: request.force,
        vendorDir: request.vendorDir,
        log: request.log,
      })
    : undefined;

  ensureToolPath();
  const capabilities = await detectAgentCapabilities();
  return {
    ok: (android?.ok ?? true) && (ios?.ok ?? true),
    capabilities,
    android,
    ios,
  };
}