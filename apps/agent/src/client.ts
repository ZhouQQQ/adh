import WebSocket from 'ws';
import {
  parseServerMessage,
  type AgentRuntimeInfo,
  type AgentToServerMessage,
  type DeviceInfo,
  type ServerToAgentMessage,
} from '@adh/protocol';
import type { Logger } from './log.js';

export interface AgentClientOptions {
  serverUrl: string;
  token: string;
  runtime: AgentRuntimeInfo;
  logger: Logger;
  /** 设备扫描函数，便于测试替换。 */
  discover: () => Promise<DeviceInfo[]>;
  /** server 下发新 token 时回调（注册码首次接入）。 */
  onToken?: (token: string) => void;
  syncIntervalMs?: number;
}

function toAgentEndpoint(serverUrl: string): string {
  const withProtocol = serverUrl
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  const url = new URL(withProtocol);
  url.pathname = '/ws/agent';
  url.search = '';
  return url.toString();
}

function sameDevice(a: DeviceInfo, b: DeviceInfo): boolean {
  return (
    a.name === b.name &&
    a.model === b.model &&
    a.osVersion === b.osVersion &&
    a.status === b.status &&
    a.resolution?.width === b.resolution?.width &&
    a.resolution?.height === b.resolution?.height &&
    JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities) &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
  );
}

export class AgentClient {
  private readonly options: AgentClientOptions;
  private token: string;
  private socket: WebSocket | null = null;
  private synced = new Map<string, DeviceInfo>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private syncing = false;

  constructor(options: AgentClientOptions) {
    this.options = options;
    this.token = options.token;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPeriodicSync();
    this.socket?.close(1000, 'agent shutdown');
  }

  private connect(): void {
    const endpoint = toAgentEndpoint(this.options.serverUrl);
    this.options.logger.info({ endpoint }, 'connecting');
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.on('open', () => {
      this.options.logger.info('connected, sending hello');
      this.send({ t: 'hello', token: this.token, agent: this.options.runtime });
    });

    socket.on('message', (raw: Buffer) => {
      const message = parseServerMessage(raw.toString());
      if (!message) return;
      this.handleServerMessage(message);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.stopPeriodicSync();
      this.options.logger.warn(
        { code, reason: reason.toString() },
        'connection closed',
      );
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      this.options.logger.debug({ err: error.message }, 'socket error');
    });
  }

  private handleServerMessage(message: ServerToAgentMessage): void {
    if (message.t === 'welcome') {
      this.reconnectAttempt = 0;
      if (message.token) {
        this.token = message.token;
        this.options.onToken?.(message.token);
      }
      this.options.logger.info(
        { agentId: message.agentId, serverVersion: message.serverVersion },
        'registered',
      );
      // 重连后 server 已把设备标记为离线，需要重新全量上报
      this.synced.clear();
      this.startPeriodicSync();
      return;
    }
    if (message.t === 'ping') {
      this.send({ t: 'pong', ts: Date.now() });
      return;
    }
    if (message.t === 'stop') {
      this.options.logger.warn({ reason: message.reason }, 'server stopped session');
    }
  }

  private send(message: AgentToServerMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private startPeriodicSync(): void {
    this.stopPeriodicSync();
    void this.syncNow();
    this.syncTimer = setInterval(
      () => void this.syncNow(),
      this.options.syncIntervalMs ?? 5_000,
    );
  }

  private stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const devices = await this.options.discover();
      const next = new Map(devices.map((device) => [device.udid, device]));
      const add: DeviceInfo[] = [];
      const update: { udid: string; patch: Partial<DeviceInfo> }[] = [];
      const remove: string[] = [];

      for (const [udid, device] of next) {
        const previous = this.synced.get(udid);
        if (!previous) add.push(device);
        else if (!sameDevice(previous, device)) update.push({ udid, patch: device });
      }
      for (const udid of this.synced.keys()) {
        if (!next.has(udid)) remove.push(udid);
      }

      if (add.length || update.length || remove.length) {
        this.send({ t: 'devices.sync', add, remove, update });
        this.options.logger.info(
          { added: add.length, updated: update.length, removed: remove.length },
          'devices synced',
        );
      }
      this.synced = next;
    } catch (error) {
      this.options.logger.warn({ err: String(error) }, 'device scan failed');
    } finally {
      this.syncing = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    this.options.logger.info({ delayMs: delay }, 'will reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}