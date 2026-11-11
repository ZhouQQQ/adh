/**
 * 设备性能采样（CPU / 内存 / 实时帧率）。
 *
 * Android 直接读 /proc/stat、/proc/meminfo；FPS 用 SurfaceFlinger 的
 * TimeStats 累计帧数取差值，旧系统回退到前台进程的 gfxinfo 帧数。
 * iOS 复用 go-ios 的 sysmontap / instruments fps。
 * server（内置 Agent）和 agent（宿主机节点）共用这份实现。
 */

import type { PerfSample } from '@adh/protocol';
import { runCommand } from './exec.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ProcStat {
  idle: number;
  total: number;
}

function parseProcStat(raw: string): ProcStat | null {
  const line = raw
    .split(/\r?\n/)
    .find((item) => item.trimStart().startsWith('cpu '));
  if (!line) return null;
  const parts = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number(value));
  if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.slice(0, 8).reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

function cpuPercent(before: ProcStat, after: ProcStat): number | null {
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0) return null;
  const value = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function parseMemory(raw: string): {
  usedMb: number;
  totalMb: number;
} | null {
  const totalKb = Number(/MemTotal:\s+(\d+)\s*kB/.exec(raw)?.[1] ?? NaN);
  const availableKb = Number(
    /MemAvailable:\s+(\d+)\s*kB/.exec(raw)?.[1] ?? NaN,
  );
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) return null;
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb: Math.round(Math.max(0, totalKb - availableKb) / 1024),
  };
}

function parseBattery(raw: string): {
  level: number | null;
  temperature: number | null;
} {
  const level = Number(/^\s*level:\s*(\d+)/m.exec(raw)?.[1] ?? NaN);
  const temperature = Number(
    /^\s*temperature:\s*(-?\d+)/m.exec(raw)?.[1] ?? NaN,
  );
  return {
    level: Number.isFinite(level) ? level : null,
    // dumpsys 的温度单位是 0.1℃
    temperature: Number.isFinite(temperature)
      ? Math.round(temperature) / 10
      : null,
  };
}

function parseNetDev(raw: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of raw.split(/\r?\n/)) {
    const [namePart, dataPart] = line.split(':');
    if (!dataPart) continue;
    const name = namePart?.trim();
    if (!name || name === 'lo') continue;
    const parts = dataPart.trim().split(/\s+/);
    const rxBytes = Number(parts[0]);
    const txBytes = Number(parts[8]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    rx += rxBytes;
    tx += txBytes;
    found = true;
  }
  return found ? { rx, tx } : null;
}

function netKbps(
  before: { rx: number; tx: number } | null,
  after: { rx: number; tx: number } | null,
  elapsedSec: number,
): { rx: number | null; tx: number | null } {
  if (!before || !after || elapsedSec <= 0) {
    return { rx: null, tx: null };
  }
  const rxDelta = after.rx - before.rx;
  const txDelta = after.tx - before.tx;
  return {
    rx:
      rxDelta >= 0
        ? Math.round((rxDelta / 1024 / elapsedSec) * 10) / 10
        : null,
    tx:
      txDelta >= 0
        ? Math.round((txDelta / 1024 / elapsedSec) * 10) / 10
        : null,
  };
}

/** 从 SurfaceFlinger TimeStats 里取当前屏幕刷新率。 */
function parseRefreshRate(raw: string): number | null {
  const matched = /displayRefreshRate\s*=\s*(\d+(?:\.\d+)?)\s*fps/i.exec(raw)?.[1];
  if (matched === undefined) return null;
  const value = Number(matched);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/** 从 ActivityManager 输出里取当前前台应用包名。 */
function parseForegroundPackage(raw: string): string | null {
  const patterns = [
    /topResumedActivity[^\n]*?([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/,
    /mResumedActivity[^\n]*?([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/,
    /mCurrentFocus[^\n]*?([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/,
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(raw)?.[1];
    if (matched && matched.includes('.')) return matched;
  }
  return null;
}

/** SurfaceFlinger TimeStats 里的全局累计帧数（Android 10+）。 */
function parseTimeStatsFrames(raw: string): number | null {
  const matched = /^totalFrames\s*=\s*(\d+)/m.exec(raw)?.[1];
  if (matched === undefined) return null;
  const value = Number(matched);
  return Number.isFinite(value) ? value : null;
}

/** gfxinfo 里的单进程累计帧数，作为旧系统的兜底。 */
function parseGfxFrameCount(raw: string): number | null {
  const matched = /Total frames rendered:\s*(\d+)/.exec(raw)?.[1];
  if (matched === undefined) return null;
  const value = Number(matched);
  return Number.isFinite(value) ? value : null;
}

function framesToFps(
  before: number | null,
  after: number | null,
  elapsedSec: number,
): number | null {
  if (before === null || after === null || elapsedSec <= 0.2) return null;
  if (after < before) return null;
  return Math.round(((after - before) / elapsedSec) * 10) / 10;
}

/**
 * Android：一次采样约 1 秒（CPU 与帧率都需要两次取差值）。
 * 帧率优先用 SurfaceFlinger TimeStats 的全局帧数，覆盖所有应用；
 * 老系统没有 --timestats 时退回到前台进程的 gfxinfo。
 */
export async function sampleAndroidPerf(udid: string): Promise<PerfSample> {
  const adb = (args: string[], timeoutMs = 8_000) =>
    runCommand('adb', ['-s', udid, ...args], timeoutMs);

  const [statBefore, meminfo, activity, netBefore, batteryRaw] =
    await Promise.all([
      adb(['shell', 'cat', '/proc/stat']),
      adb(['shell', 'cat', '/proc/meminfo']),
      adb(['shell', 'dumpsys', 'activity', 'activities'], 6_000),
      adb(['shell', 'cat', '/proc/net/dev']),
      adb(['shell', 'dumpsys', 'battery'], 6_000),
    ]);

  const before = parseProcStat(statBefore.stdout);
  const foreground = parseForegroundPackage(activity.stdout);
  const netStartedAt = Date.now();

  // 帧率窗口单独计时，避免把前置 adb 命令的耗时算进去
  const timeStatsBefore = await adb(
    ['shell', 'dumpsys', 'SurfaceFlinger', '--timestats', '-dump'],
    8_000,
  );
  const globalFramesBefore = parseTimeStatsFrames(timeStatsBefore.stdout);
  let fpsStartedAt = Date.now();

  // TimeStats 不可用时，记录前台进程 gfxinfo 的起始帧数
  let gfxFramesBefore: number | null = null;
  if (globalFramesBefore === null && foreground) {
    const gfxBefore = await adb(
      ['shell', 'dumpsys', 'gfxinfo', foreground],
      6_000,
    );
    gfxFramesBefore = parseGfxFrameCount(gfxBefore.stdout);
    fpsStartedAt = Date.now();
  }

  await sleep(600);

  const [statAfter, timeStatsAfter, gfxAfter, netAfter] = await Promise.all([
    adb(['shell', 'cat', '/proc/stat']),
    adb(['shell', 'dumpsys', 'SurfaceFlinger', '--timestats', '-dump'], 8_000),
    gfxFramesBefore !== null && foreground
      ? adb(['shell', 'dumpsys', 'gfxinfo', foreground], 6_000)
      : Promise.resolve(null),
    adb(['shell', 'cat', '/proc/net/dev']),
  ]);
  const elapsedSec = (Date.now() - fpsStartedAt) / 1000;
  const netElapsedSec = (Date.now() - netStartedAt) / 1000;

  const after = parseProcStat(statAfter.stdout);
  const memory = parseMemory(meminfo.stdout);
  const battery = parseBattery(batteryRaw.stdout);
  const net = netKbps(
    parseNetDev(netBefore.stdout),
    parseNetDev(netAfter.stdout),
    netElapsedSec,
  );

  const fps =
    framesToFps(
      globalFramesBefore,
      parseTimeStatsFrames(timeStatsAfter.stdout),
      elapsedSec,
    ) ??
    framesToFps(
      gfxFramesBefore,
      gfxAfter ? parseGfxFrameCount(gfxAfter.stdout) : null,
      elapsedSec,
    );

  return {
    ts: Date.now(),
    cpu: before && after ? cpuPercent(before, after) : null,
    memoryUsedMb: memory?.usedMb ?? null,
    memoryTotalMb: memory?.totalMb ?? null,
    fps,
    refreshRate:
      parseRefreshRate(timeStatsAfter.stdout) ??
      parseRefreshRate(timeStatsBefore.stdout),
    batteryLevel: battery.level,
    batteryTemperature: battery.temperature,
    networkRxKbps: net.rx,
    networkTxKbps: net.tx,
  };
}

export type RunIosCommand = (
  args: string[],
  timeoutMs?: number,
) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
} | null>;

function parseSysmontapCpu(output: string): number | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.includes('cpu_total_load')) continue;

    let load = NaN;
    let cpus = 1;
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line) as {
          cpu_total_load?: unknown;
          enabled_cpus?: unknown;
          cpu_count?: unknown;
        };
        load = Number(parsed.cpu_total_load);
        cpus = Number(parsed.enabled_cpus ?? parsed.cpu_count) || 1;
      } catch {
        continue;
      }
    } else {
      load = Number(/cpu_total_load=(-?\d+(?:\.\d+)?)/.exec(line)?.[1]);
      cpus = Number(/enabled_cpus=(\d+)/.exec(line)?.[1]) || 1;
    }

    if (!Number.isFinite(load)) continue;
    // sysmontap 的 cpu_total_load 是各核占用之和（6 核满载约 600），
    // 除以核数才是整机 0~100 的占用率。
    const percent = load / (cpus > 0 ? cpus : 1);
    return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
  }
  return null;
}

function parseInstrumentsFps(raw: string): number | null {
  let latest: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(text) as { fps?: unknown };
      const value = Number(parsed.fps);
      if (Number.isFinite(value)) latest = value;
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  if (latest === null) return null;
  return Math.max(0, Math.round(latest * 10) / 10);
}

function parseIosBattery(raw: string): {
  level: number | null;
  temperature: number | null;
} {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { level: null, temperature: null };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      CurrentCapacity?: unknown;
      BatteryCurrentCapacity?: unknown;
      Temperature?: unknown;
    };
    const level = Number(parsed.CurrentCapacity ?? parsed.BatteryCurrentCapacity);
    const temp = Number(parsed.Temperature);
    const celsius = temp > 200 ? temp / 100 : temp;
    return {
      level: Number.isFinite(level) ? level : null,
      // batteryregistry 的 Temperature 是 0.01℃（2989 => 29.89℃）
      temperature: Number.isFinite(temp)
        ? Math.round(celsius * 10) / 10
        : null,
    };
  } catch {
    return { level: null, temperature: null };
  }
}

/**
 * iOS：sysmontap 只给 CPU，instruments graphics 给实时 FPS。
 * 两个命令都是流式的，这里按固定时长采样后取最后一次结果；
 * go-ios 没有开放内存指标，所以 memory 保持 null。
 */
export async function sampleIosPerf(
  udid: string,
  runIos: RunIosCommand,
): Promise<PerfSample> {
  const [cpuResult, fpsResult, batteryResult] = await Promise.all([
    runIos(['sysmontap', `--udid=${udid}`], 3_000).catch(() => null),
    runIos(
      ['instruments', 'fps', '--duration=1.4', `--udid=${udid}`],
      7_000,
    ).catch(() => null),
    runIos(['batteryregistry', `--udid=${udid}`], 4_000).catch(() => null),
  ]);

  const cpu = cpuResult
    ? parseSysmontapCpu(`${cpuResult.stdout}\n${cpuResult.stderr}`)
    : null;
  const fps = fpsResult ? parseInstrumentsFps(fpsResult.stdout) : null;
  const battery = batteryResult
    ? parseIosBattery(`${batteryResult.stdout}\n${batteryResult.stderr}`)
    : { level: null, temperature: null };

  return {
    ts: Date.now(),
    cpu,
    memoryUsedMb: null,
    memoryTotalMb: null,
    fps,
    refreshRate: null,
    batteryLevel: battery.level,
    batteryTemperature: battery.temperature,
    networkRxKbps: null,
    networkTxKbps: null,
  };
}
