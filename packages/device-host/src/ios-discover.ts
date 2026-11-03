import type { DeviceInfo } from '@adh/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { runCommand } from './exec.js';
import { lookupIosHardware, lookupIosResolution } from './ios-models.js';

/**
 * iOS 设备发现：通过 go-ios 列出设备并读取基本信息。
 * go-ios 的二进制可能是 ios（Windows 为 ios.exe）或 go-ios，两个都探测。
 */

interface IosInfo {
  DeviceName?: string;
  ProductVersion?: string;
  ProductType?: string;
  HardwareModel?: string;
  CPUArchitecture?: string;
  BuildVersion?: string;
}

interface CacheEntry {
  at: number;
  info: IosInfo;
}

const INFO_TTL_MS = 30_000;
const WDA_TTL_MS = 15_000;
const infoCache = new Map<string, CacheEntry>();

let commandCache: { at: number; command: string | null } | null = null;
let wdaCache: { at: number; available: boolean } | null = null;

/** WDA 启动成功后清掉探测缓存，让下一次发现立即带上 wda 能力。 */
export function invalidateWdaCache(): void {
  wdaCache = null;
}

async function resolveCommand(): Promise<string | null> {
  if (commandCache && Date.now() - commandCache.at < 60_000) {
    return commandCache.command;
  }
  for (const command of ['ios', 'go-ios']) {
    const result = await runCommand(command, ['version'], 5_000);
    if (!result.failedToStart) {
      commandCache = { at: Date.now(), command };
      return command;
    }
  }
  commandCache = { at: Date.now(), command: null };
  return null;
}

/** go-ios 默认输出 JSON，但可能混入日志行，截取首尾大括号再解析。 */
function parseJson<T>(raw: string): T | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function listUdids(command: string): Promise<string[]> {
  const result = await runCommand(command, ['list'], 10_000);
  if (result.code !== 0) return [];

  const parsed = parseJson<{
    deviceList?: (string | { udid?: string; UniqueDeviceID?: string })[];
  }>(result.stdout);
  const list = parsed?.deviceList ?? [];

  return list
    .map((item) =>
      typeof item === 'string' ? item : item.udid ?? item.UniqueDeviceID ?? '',
    )
    .filter(Boolean);
}

async function loadInfo(command: string, udid: string): Promise<IosInfo | null> {
  const cached = infoCache.get(udid);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.info;

  const result = await runCommand(command, ['info', `--udid=${udid}`], 15_000);
  if (result.code !== 0) return null;

  const info = parseJson<IosInfo>(result.stdout);
  if (info) infoCache.set(udid, { at: Date.now(), info });
  return info;
}

/** WDA 默认监听 8100，有端口转发时才算可用。 */
async function probeWda(force = false): Promise<boolean> {
  if (!force && wdaCache && Date.now() - wdaCache.at < WDA_TTL_MS) {
    return wdaCache.available;
  }

  let available = false;
  try {
    const response = await fetch('http://127.0.0.1:8100/status', {
      signal: AbortSignal.timeout(800),
    });
    available = response.ok;
  } catch {
    available = false;
  }
  wdaCache = { at: Date.now(), available };
  return available;
}

/* ------------------------------------------------------------------ */
/* WDA 端口转发                                                        */
/* ------------------------------------------------------------------ */

let forwardProcess: ChildProcess | null = null;
let forwardUdid: string | null = null;
let forwardRetryAt = 0;

/**
 * 手机上 WDA 已经在跑、但没做端口转发时，本机 8100 是打不开的。
 * 这里自动补一条 `ios forward 8100 8100 --udid=<udid>`，让 WDA 立即可用。
 * @returns 是否新起了转发进程
 */
function ensureForward(command: string, udid: string): boolean {
  if (
    forwardProcess &&
    forwardUdid === udid &&
    forwardProcess.exitCode === null
  ) {
    return false;
  }
  // 端口被别的进程占用时会立刻退出，退避一分钟再试
  if (Date.now() < forwardRetryAt) return false;

  stopForward();

  const child = spawn(command, ['forward', '8100', '8100', `--udid=${udid}`], {
    windowsHide: true,
    stdio: 'ignore',
  });
  forwardProcess = child;
  forwardUdid = udid;
  const startedAt = Date.now();

  const cleanup = (): void => {
    if (forwardProcess !== child) return;
    forwardProcess = null;
    forwardUdid = null;
    // 刚起来就退出多半是端口被占用；跑过一会儿才退出说明设备断开了
    if (Date.now() - startedAt < 3_000) {
      forwardRetryAt = Date.now() + 60_000;
    }
  };
  child.on('exit', cleanup);
  child.on('error', cleanup);

  return true;
}

function stopForward(): void {
  const child = forwardProcess;
  forwardProcess = null;
  forwardUdid = null;
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    /* 进程可能已经退出 */
  }
}

process.on('exit', stopForward);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function discoverIos(): Promise<DeviceInfo[]> {
  const command = await resolveCommand();
  if (!command) return [];

  const udids = await listUdids(command);
  if (udids.length === 0) {
    stopForward();
    infoCache.clear();
    return [];
  }

  let wda = await probeWda();
  if (!wda && ensureForward(command, udids[0]!)) {
    // 转发起来后给它一点时间建立连接
    await delay(1_200);
    wda = await probeWda(true);
  }
  // WDA 未启动时也上报设备，前端会提示并提供「启动 WDA」入口
  const capabilities = wda ? ['ios', 'wda'] : ['ios'];

  const devices: DeviceInfo[] = [];

  for (const udid of udids) {
    const info = await loadInfo(command, udid);
    const device: DeviceInfo = {
      udid,
      platform: 'ios',
      name: info?.DeviceName ?? udid,
      brand: 'Apple',
      status: 'online',
      capabilities,
      tags: [],
    };

    if (info?.ProductType) device.model = info.ProductType;
    if (info?.ProductVersion) device.osVersion = info.ProductVersion;
    if (info?.CPUArchitecture) device.cpuArch = info.CPUArchitecture;
    // Apple 没有公开的 SoC 代号，这里用硬件代号（如 D79AP）代替
    if (info?.HardwareModel) device.cpuCode = info.HardwareModel;

    const hardware = lookupIosHardware(info?.ProductType);
    if (hardware) {
      device.marketName = hardware.name;
      device.cpu = `Apple ${hardware.soc}`;
      device.cpuVendor = 'Apple';
      device.cpuModel = hardware.soc;
      device.cpuCores = hardware.cpuCores;
      device.memoryMb = hardware.memoryMb;
    }

    const resolution = lookupIosResolution(info?.ProductType);
    if (resolution) device.resolution = resolution;

    devices.push(device);
  }

  for (const udid of [...infoCache.keys()]) {
    if (!udids.includes(udid)) infoCache.delete(udid);
  }

  return devices;
}