import os from 'node:os';
import { BUILTIN_AGENT_ID, type DeviceInfo } from '@adh/protocol';
import {
  captureThumbnail,
  detectAgentCapabilities,
  discoverAndroid,
  discoverIos,
  getTunnelStatus,
} from '@adh/device-host';
import type { Queries } from './db/queries.js';
import type { Logger } from './log.js';
import type { ThumbnailStore } from './storage/thumbnails.js';
import type { WebHub } from './ws/web-hub.js';

const DISCOVERY_INTERVAL_MS = 5_000;
const THUMBNAIL_INTERVAL_MS = 30_000;

export interface LocalAgentDeps {
  queries: Queries;
  hub: WebHub;
  thumbnails: ThumbnailStore;
  logger: Logger;
  version: string;
}

function sameDevice(a: DeviceInfo, b: DeviceInfo): boolean {
  return (
    a.name === b.name &&
    a.model === b.model &&
    a.brand === b.brand &&
    a.osVersion === b.osVersion &&
    a.sdk === b.sdk &&
    a.cpu === b.cpu &&
    a.cpuCores === b.cpuCores &&
    a.memoryMb === b.memoryMb &&
    a.rooted === b.rooted &&
    a.status === b.status &&
    a.wdaPort === b.wdaPort &&
    a.resolution?.width === b.resolution?.width &&
    a.resolution?.height === b.resolution?.height &&
    JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities)
  );
}

/**
 * server 进程内直连本机设备，不经过 WebSocket。
 * 对使用方来说它就是一个 id 固定为 builtin-local 的 Agent。
 */
export class LocalAgent {
  private readonly tracked = new Map<string, DeviceInfo>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private thumbnailTimer: NodeJS.Timeout | null = null;
  private discovering = false;
  private capturing = false;
  private started = false;
  /** 每 3 次扫描刷新一次隧道状态，约 15 秒。 */
  private tunnelTick = 0;

  constructor(private readonly deps: LocalAgentDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const capabilities = await detectAgentCapabilities();
    const adbAvailable = capabilities.includes('android');
    const row = await this.deps.queries.ensureBuiltinAgent(
      os.hostname(),
      this.deps.version,
      capabilities,
    );

    this.deps.logger.info(
      { agentId: row.id, name: row.name, adbAvailable },
      'builtin local agent started',
    );

    // server 重启后内存里的 tracked 是空的，先把库里遗留的在线状态清掉，
    // 再由第一轮扫描把仍在线的设备恢复，避免未连接的设备一直显示在线。
    const stale = await this.deps.queries.markAgentDevicesOffline(BUILTIN_AGENT_ID);
    for (const device of stale) {
      this.deps.hub.broadcast({ t: 'device.updated', device });
    }

    void this.discover();
    this.discoveryTimer = setInterval(
      () => void this.discover(),
      DISCOVERY_INTERVAL_MS,
    );

    const firstCapture = setTimeout(() => void this.captureThumbnails(), 6_000);
    firstCapture.unref?.();
    this.thumbnailTimer = setInterval(
      () => void this.captureThumbnails(),
      THUMBNAIL_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.thumbnailTimer) clearInterval(this.thumbnailTimer);
    this.discoveryTimer = null;
    this.thumbnailTimer = null;
    this.started = false;
  }

  private async discover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const [android, ios] = await Promise.all([discoverAndroid(), discoverIos()]);
      const next = new Map<string, DeviceInfo>();
      for (const device of [...android.devices, ...ios]) {
        next.set(device.udid, device);
      }

      const { queries, hub } = this.deps;

      for (const udid of this.tracked.keys()) {
        if (next.has(udid)) continue;
        // 只标记离线，记录留给控制台查看
        const offline = await queries.markDeviceOffline(BUILTIN_AGENT_ID, udid);
        if (offline) hub.broadcast({ t: 'device.updated', device: offline });
      }

      for (const [udid, info] of next) {
        const previous = this.tracked.get(udid);
        if (!previous) {
          const device = await queries.upsertDevice(BUILTIN_AGENT_ID, info);
          hub.broadcast({ t: 'device.updated', device });
          continue;
        }
        if (sameDevice(previous, info)) continue;
        const device =
          (await queries.patchDevice(BUILTIN_AGENT_ID, udid, info)) ??
          (await queries.upsertDevice(BUILTIN_AGENT_ID, info));
        hub.broadcast({ t: 'device.updated', device });
      }

      this.tracked.clear();
      for (const [udid, info] of next) this.tracked.set(udid, info);
      await queries.touchAgent(BUILTIN_AGENT_ID);
      await this.refreshTunnel();
    } catch (error) {
      this.deps.logger.debug({ err: String(error) }, 'local device scan failed');
    } finally {
      this.discovering = false;
    }
  }

  /** 内置 Agent 不走 WebSocket，直接写库并广播隧道状态。 */
  private async refreshTunnel(): Promise<void> {
    this.tunnelTick += 1;
    if (this.tunnelTick % 3 !== 0) return;
    try {
      const status = await getTunnelStatus();
      await this.deps.queries.updateAgentTunnel(BUILTIN_AGENT_ID, status);
      const agent = await this.deps.queries.getAgentSummary(BUILTIN_AGENT_ID);
      if (agent) {
        this.deps.hub.broadcast({
          t: 'agent.updated',
          agent: { ...agent, online: true },
        });
      }
    } catch (error) {
      this.deps.logger.debug({ err: String(error) }, 'local tunnel status failed');
    }
  }

  private async captureThumbnails(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    try {
      const { queries, hub, thumbnails } = this.deps;
      const targets = [...this.tracked.values()]
        .filter(
          (device) => device.platform === 'android' && device.status === 'online',
        )
        .slice(0, 4);

      for (const device of targets) {
        const jpeg = await captureThumbnail(device.udid);
        if (!jpeg) continue;
        const row = await queries.findDevice(BUILTIN_AGENT_ID, device.udid);
        if (!row) continue;
        // 手动上传过图片的设备不再被自动截图覆盖
        if (row.thumbnailSource === 'manual') continue;
        thumbnails.save(row.id, jpeg);
        const updated = await queries.markThumbnail(row.id);
        if (updated) hub.broadcast({ t: 'device.updated', device: updated });
      }
    } catch (error) {
      this.deps.logger.debug({ err: String(error) }, 'local thumbnail failed');
    } finally {
      this.capturing = false;
    }
  }
}
