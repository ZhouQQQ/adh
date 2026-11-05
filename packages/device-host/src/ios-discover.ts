import type { DeviceInfo } from '@adh/protocol';
import { runCommand } from './exec.js';
import { ensureTunnelRunning } from './ios-tunnel.js';
import { lookupIosHardware, lookupIosResolution } from './ios-models.js';
import {
  ensureWdaForward,
  probeWda,
  releaseWdaPort,
  wdaPortFor,
} from './ios-wda.js';
import { logInfo } from './log.js';
import { autoStartWda, hasWdaRunner } from './ios-wda-runner.js';

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
const infoCache = new Map<string, CacheEntry>();

let commandCache: { at: number; command: string | null } | null = null;

/**
 * WDA 启动成功后调用。
 * 现在每次发现都会实时探测每台设备的端口，这里保留为空实现以兼容调用方。
 */
export function invalidateWdaCache(): void {
  /* no-op */
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

let lastLoggedCount = -1;
const wdaStates = new Map<string, boolean>();
/** 子进程还活着、但 WDA 探测失败的连续轮数。 */
const stalledProbes = new Map<string, number>();
const STALLED_PROBE_LIMIT = 3;

export async function discoverIos(): Promise<DeviceInfo[]> {
  const command = await resolveCommand();
  if (!command) return [];

  // iOS 17+ 需要 tunnel 才能稳定访问设备，发现前先确保启动
  await ensureTunnelRunning();

  const udids = await listUdids(command);
  if (udids.length !== lastLoggedCount) {
    lastLoggedCount = udids.length;
    if (udids.length === 0) {
      logInfo('[ios] 未发现设备（请确认 USB 连接和已信任电脑）');
    } else {
      logInfo(`[ios] 发现 ${udids.length} 台设备：${udids.join(', ')}`);
    }
  }
  if (udids.length === 0) {
    for (const udid of infoCache.keys()) releaseWdaPort(udid);
    infoCache.clear();
    wdaStates.clear();
    return [];
  }

  const devices: DeviceInfo[] = [];

  for (const udid of udids) {
    const info = await loadInfo(command, udid);

    // 每台设备用自己的端口：先探测，不通再补一条 `ios forward` 转发。
    // 设备上 WDA 已经在跑、只是没转发时，这一步就能让它立即可用。
    const port = wdaPortFor(udid);
    let wda = await probeWda(port);
    if (!wda) {
      if (await ensureWdaForward(udid, port)) wda = await probeWda(port);
    }
    if (!wda) {
      if (hasWdaRunner(udid)) {
        // 子进程还在但 /status 不通：多半是 XCTest 已崩、go-ios 没退出。
        // 连续 3 轮（约 15 秒）都这样才强制重启，避免瞬时抖动误杀。
        const failures = (stalledProbes.get(udid) ?? 0) + 1;
        stalledProbes.set(udid, failures);
        if (failures >= STALLED_PROBE_LIMIT) {
          stalledProbes.delete(udid);
          logInfo(`[ios] ${udid} WDA 连续 ${failures} 轮无响应，强制重启`);
          autoStartWda(udid, { force: true });
        }
      } else {
        stalledProbes.delete(udid);
        // 没在跑就后台自动拉起 XCTest：多台设备会排队，失败只记日志
        autoStartWda(udid);
      }
    } else {
      stalledProbes.delete(udid);
      if (!hasWdaRunner(udid)) {
        // 已有外部 WDA 实例（非本 agent 拉起）：后台重启一次由 agent 接管
        autoStartWda(udid, { force: true });
      }
    }
    if (wdaStates.get(udid) !== wda) {
      wdaStates.set(udid, wda);
      logInfo(`[ios] ${udid} WDA ${wda ? `已就绪（:${port}）` : '未启动'}`);
    }

    const device: DeviceInfo = {
      udid,
      platform: 'ios',
      name: info?.DeviceName ?? udid,
      brand: 'Apple',
      status: 'online',
      // WDA 未启动时也上报设备，前端会提示并提供「启动 XCTest + 转发」入口
      capabilities: wda ? ['ios', 'wda'] : ['ios'],
      tags: [],
      // 这台 agent 上给该设备分配的转发端口，server 直接展示
      wdaPort: port,
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
  // 设备拔掉后释放它的端口，避免端口号一直往后涨
  for (const udid of [...wdaStates.keys()]) {
    if (!udids.includes(udid)) {
      wdaStates.delete(udid);
      stalledProbes.delete(udid);
      releaseWdaPort(udid);
    }
  }

  return devices;
}