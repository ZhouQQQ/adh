import type { DeviceInfo, Resolution } from '@adh/protocol';
import { resolveSocName } from './soc.js';
import { runCommand } from './exec.js';

interface AndroidDetail {
  model?: string;
  marketName?: string;
  brand?: string;
  osVersion?: string;
  sdk?: number;
  cpu?: string;
  cpuCores?: number;
  memoryMb?: number;
  resolution?: Resolution;
}

export interface AndroidScanResult {
  /** adb 是否可用；不可用时 agent 仍在线，只是没有设备。 */
  adbAvailable: boolean;
  devices: DeviceInfo[];
}

export async function isAdbAvailable(): Promise<boolean> {
  const result = await runCommand('adb', ['version'], 5_000);
  return !result.failedToStart && result.code === 0;
}

/** 设备信息查询较慢，只在设备首次出现时执行。 */
const detailCache = new Map<string, AndroidDetail>();

export function clearAndroidDetailCache(): void {
  detailCache.clear();
}

function parseGetprop(raw: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\[(.+?)\]:\s*\[(.*)\]$/.exec(line.trim());
    if (match) props.set(match[1] as string, match[2] ?? '');
  }
  return props;
}

function parseWmSize(raw: string): Resolution | undefined {
  const matches = [...raw.matchAll(/(\d+)\s*x\s*(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  return { width: Number(last[1]), height: Number(last[2]) };
}

/**
 * 各家 ROM 的市场名称属性不统一，按常见厂商依次尝试。
 * 取不到就回退到 ro.product.model（型号代码）。
 */
const MARKET_NAME_KEYS = [
  'ro.vivo.market.name',
  'ro.product.marketname',
  'ro.vendor.oplus.market.name',
  'ro.config.marketing_name',
  'ro.product.odm.marketname',
  'ro.vendor.product.marketname',
  'ro.product.vendor.marketname',
];

function readMarketName(props: Map<string, string>): string | undefined {
  for (const key of MARKET_NAME_KEYS) {
    const value = props.get(key)?.trim();
    if (value) return value;
  }
  return undefined;
}

/** 优先用 ro.soc.model，其次是 board platform / hardware，最后退到 ABI。 */
function buildCpuName(props: Map<string, string>): string | undefined {
  const candidates = [
    props.get('ro.soc.model'),
    props.get('ro.vendor.soc.model'),
    props.get('ro.board.platform'),
    props.get('ro.hardware'),
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    const resolved = resolveSocName(value);
    if (resolved) return resolved;
  }

  return props.get('ro.product.cpu.abi')?.trim() || undefined;
}

function parseCores(cpuInfo: string): number | undefined {
  const count = (cpuInfo.match(/^processor\s*:/gm) ?? []).length;
  return count > 0 ? count : undefined;
}

function parseMemoryMb(memInfo: string): number | undefined {
  const match = /MemTotal:\s*(\d+)\s*kB/i.exec(memInfo);
  if (!match) return undefined;
  const kb = Number(match[1]);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
}

async function queryDetails(udid: string): Promise<AndroidDetail> {
  const [propsResult, sizeResult, memResult, cpuResult] = await Promise.all([
    runCommand('adb', ['-s', udid, 'shell', 'getprop'], 8_000),
    runCommand('adb', ['-s', udid, 'shell', 'wm', 'size'], 6_000),
    runCommand('adb', ['-s', udid, 'shell', 'cat', '/proc/meminfo'], 6_000),
    runCommand('adb', ['-s', udid, 'shell', 'cat', '/proc/cpuinfo'], 6_000),
  ]);

  const props = parseGetprop(propsResult.stdout);
  const detail: AndroidDetail = {};

  const model = props.get('ro.product.model')?.trim();
  if (model) detail.model = model;
  const marketName = readMarketName(props);
  if (marketName) detail.marketName = marketName;
  const brand = props.get('ro.product.brand')?.trim();
  if (brand) detail.brand = brand;
  const release = props.get('ro.build.version.release')?.trim();
  if (release) detail.osVersion = release;
  const sdk = Number(props.get('ro.build.version.sdk'));
  if (Number.isFinite(sdk) && sdk > 0) detail.sdk = sdk;

  const cpu = buildCpuName(props);
  if (cpu) detail.cpu = cpu;
  const cores = parseCores(cpuResult.stdout);
  if (cores) detail.cpuCores = cores;
  const memoryMb = parseMemoryMb(memResult.stdout);
  if (memoryMb) detail.memoryMb = memoryMb;

  const resolution = parseWmSize(sizeResult.stdout);
  if (resolution) detail.resolution = resolution;

  return detail;
}

export async function discoverAndroid(): Promise<AndroidScanResult> {
  const result = await runCommand('adb', ['devices', '-l'], 8_000);
  if (result.failedToStart) {
    return { adbAvailable: false, devices: [] };
  }
  if (result.code !== 0) {
    return { adbAvailable: true, devices: [] };
  }

  const devices: DeviceInfo[] = [];
  const seen = new Set<string>();

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices')) continue;

    const parts = trimmed.split(/\s+/);
    const udid = parts[0];
    const state = parts[1];
    if (!udid || !state) continue;
    seen.add(udid);

    if (state === 'unauthorized') {
      detailCache.delete(udid);
      devices.push({
        udid,
        platform: 'android',
        name: udid,
        status: 'unauthorized',
        capabilities: [],
        tags: [],
      });
      continue;
    }
    if (state !== 'device') continue;

    let detail = detailCache.get(udid);
    if (!detail) {
      detail = await queryDetails(udid);
      detailCache.set(udid, detail);
    }

    const info: DeviceInfo = {
      udid,
      platform: 'android',
      name: detail.marketName ?? detail.model ?? udid,
      status: 'online',
      capabilities: ['adb', 'shell', 'screenshot', 'input'],
      tags: [],
    };
    if (detail.model) info.model = detail.model;
    if (detail.marketName) info.marketName = detail.marketName;
    if (detail.brand) info.brand = detail.brand;
    if (detail.osVersion) info.osVersion = detail.osVersion;
    if (detail.sdk) info.sdk = detail.sdk;
    if (detail.cpu) info.cpu = detail.cpu;
    if (detail.cpuCores) info.cpuCores = detail.cpuCores;
    if (detail.memoryMb) info.memoryMb = detail.memoryMb;
    if (detail.resolution) info.resolution = detail.resolution;
    devices.push(info);
  }

  for (const udid of [...detailCache.keys()]) {
    if (!seen.has(udid)) detailCache.delete(udid);
  }

  return { adbAvailable: true, devices };
}