import type { DeviceInfo, Resolution } from '@adh/protocol';
import { runCommand } from '../util/exec.js';

export async function isAdbAvailable(): Promise<boolean> {
  const result = await runCommand('adb', ['version'], 5_000);
  return !result.failedToStart && result.code === 0;
}

interface AndroidDetail {
  model?: string;
  osVersion?: string;
  resolution?: Resolution;
}

/** 设备信息查询较慢，只在设备首次出现时执行。 */
const detailCache = new Map<string, AndroidDetail>();

function parseWmSize(raw: string): Resolution | undefined {
  const matches = [...raw.matchAll(/(\d+)\s*x\s*(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  return { width: Number(last[1]), height: Number(last[2]) };
}

async function queryDetails(udid: string): Promise<AndroidDetail> {
  const [model, version, size] = await Promise.all([
    runCommand('adb', ['-s', udid, 'shell', 'getprop', 'ro.product.model'], 6_000),
    runCommand(
      'adb',
      ['-s', udid, 'shell', 'getprop', 'ro.build.version.release'],
      6_000,
    ),
    runCommand('adb', ['-s', udid, 'shell', 'wm', 'size'], 6_000),
  ]);

  const detail: AndroidDetail = {};
  const modelText = model.stdout.trim();
  if (modelText) detail.model = modelText;
  const versionText = version.stdout.trim();
  if (versionText) detail.osVersion = versionText;
  const resolution = parseWmSize(size.stdout);
  if (resolution) detail.resolution = resolution;
  return detail;
}

export interface AndroidScanResult {
  /** adb 是否可用；不可用时 server 会显示 agent 在线但无设备。 */
  adbAvailable: boolean;
  devices: DeviceInfo[];
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
      name: detail.model ?? udid,
      status: 'online',
      capabilities: ['adb', 'shell', 'screenshot', 'input'],
      tags: [],
    };
    if (detail.model) info.model = detail.model;
    if (detail.osVersion) info.osVersion = detail.osVersion;
    if (detail.resolution) info.resolution = detail.resolution;
    devices.push(info);
  }

  for (const udid of [...detailCache.keys()]) {
    if (!seen.has(udid)) detailCache.delete(udid);
  }

  return { adbAvailable: true, devices };
}