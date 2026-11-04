import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentRuntimeInfo,
  AgentSummary,
  DeviceInfo,
  DeviceStatus,
  DeviceSummary,
  IosTunnelStatus,
  Platform,
  Resolution,
  SafeKeyboardLayout,
} from '@adh/protocol';
import { BUILTIN_AGENT_ID } from '@adh/protocol';
import { wdaPortFor } from '@adh/device-host';
import type { SqlDriver } from './driver.js';
import type { AgentRow, DeviceRow } from './schema.js';

const AGENT_COLUMNS = `
  id, name, host_name AS hostName, os, arch, version, capabilities,
  token, last_seen AS lastSeen, created_at AS createdAt,
  tunnel_status AS tunnelStatus
`;

const DEVICE_COLUMNS = `
  id, agent_id AS agentId, udid, platform, name, model,
  market_name AS marketName, brand, os_version AS osVersion, sdk,
  cpu, cpu_vendor AS cpuVendor, cpu_model AS cpuModel, cpu_cores AS cpuCores,
  cpu_arch AS cpuArch, cpu_code AS cpuCode,
  memory_mb AS memoryMb, rooted, resolution, status, capabilities, tags,
  last_seen AS lastSeen, thumbnail_at AS thumbnailAt,
  thumbnail_source AS thumbnailSource, published_at AS publishedAt,
  safe_keyboard AS safeKeyboard,
  locked, locked_by AS lockedBy, locked_at AS lockedAt
`;

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function parseResolution(raw: string | null): Resolution | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<Resolution>;
    if (typeof value.width === 'number' && typeof value.height === 'number') {
      return { width: value.width, height: value.height };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function parseSafeKeyboard(
  raw: string | null,
): SafeKeyboardLayout | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<SafeKeyboardLayout>;
    const numbers = [value.x, value.y, value.height, value.opacity];
    if (numbers.every((item) => typeof item === 'number')) {
      return {
        x: value.x as number,
        y: value.y as number,
        height: value.height as number,
        opacity: value.opacity as number,
        type: value.type === 'full' ? 'full' : 'password',
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function maskKey(key: string): string {
  if (key.length <= 18) return key;
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}

/** Agent 接入凭证：adh_ 前缀 + 32 位 hex。 */
export function generateAgentKey(): string {
  return `adh_${randomBytes(16).toString('hex')}`;
}

function parseTunnelStatus(raw: string | null): IosTunnelStatus | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<IosTunnelStatus>;
    if (typeof value.running !== 'boolean') return undefined;
    return {
      running: value.running,
      tunnels: Array.isArray(value.tunnels) ? value.tunnels : [],
      error: typeof value.error === 'string' ? value.error : undefined,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export function rowToAgent(row: AgentRow, deviceCount = 0): AgentSummary {
  return {
    id: row.id,
    name: row.name,
    hostName: row.hostName ?? undefined,
    os: row.os,
    arch: row.arch,
    version: row.version,
    capabilities: parseStringArray(row.capabilities),
    keyPreview: maskKey(row.token),
    deviceCount,
    lastSeen: Number(row.lastSeen),
    createdAt: Number(row.createdAt),
    online: false,
    pending: Number(row.lastSeen) === 0,
    builtin: row.id === BUILTIN_AGENT_ID,
    tunnel: parseTunnelStatus(row.tunnelStatus),
  };
}

export function rowToDevice(row: DeviceRow): DeviceSummary {
  const summary: DeviceSummary = {
    id: row.id,
    agentId: row.agentId,
    udid: row.udid,
    platform: row.platform as Platform,
    name: row.name,
    status: row.status as DeviceStatus,
    capabilities: parseStringArray(row.capabilities),
    tags: parseStringArray(row.tags),
    lastSeen: Number(row.lastSeen),
    thumbnailAt: Number(row.thumbnailAt ?? 0),
    thumbnailSource: (row.thumbnailSource as 'auto' | 'manual') ?? 'auto',
    publishedAt: Number(row.publishedAt ?? 0),
    inUse: false,
    locked: Boolean(row.locked),
    lockedAt: Number(row.lockedAt ?? 0),
  };
  if (row.model) summary.model = row.model;
  if (row.marketName) summary.marketName = row.marketName;
  if (row.brand) summary.brand = row.brand;
  if (row.osVersion) summary.osVersion = row.osVersion;
  if (row.sdk != null) summary.sdk = Number(row.sdk);
  if (row.cpu) summary.cpu = row.cpu;
  if (row.cpuVendor) summary.cpuVendor = row.cpuVendor;
  if (row.cpuModel) summary.cpuModel = row.cpuModel;
  if (row.cpuCores != null) summary.cpuCores = Number(row.cpuCores);
  if (row.cpuArch) summary.cpuArch = row.cpuArch;
  if (row.cpuCode) summary.cpuCode = row.cpuCode;
  if (row.memoryMb != null) summary.memoryMb = Number(row.memoryMb);
  if (row.rooted != null) summary.rooted = Boolean(row.rooted);
  const resolution = parseResolution(row.resolution);
  if (resolution) summary.resolution = resolution;
  const safeKeyboard = parseSafeKeyboard(row.safeKeyboard);
  if (safeKeyboard) summary.safeKeyboard = safeKeyboard;

  if (row.lockedBy) summary.lockedBy = row.lockedBy;

  // iOS 设备的 WDA 端口按设备分配；本机接入的设备才有实际意义
  if (
    row.platform === 'ios' &&
    row.agentId === BUILTIN_AGENT_ID &&
    row.status === 'online'
  ) {
    summary.wdaPort = wdaPortFor(row.udid);
  }

  return summary;
}

export function createQueries(db: SqlDriver) {
  const deviceCounts = async (): Promise<Map<string, number>> => {
    const rows = await db.query<{ agentId: string; count: number }>(`
      SELECT agent_id AS agentId, COUNT(*) AS count
      FROM adh_devices
      GROUP BY agent_id
    `);
    return new Map(rows.map((row) => [row.agentId, Number(row.count)]));
  };

  return {
    async listAgents(): Promise<AgentSummary[]> {
      const counts = await deviceCounts();
      const rows = await db.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM adh_agents`,
      );
      return rows.map((row) => rowToAgent(row, counts.get(row.id) ?? 0));
    },

    async getAgentSummary(id: string): Promise<AgentSummary | undefined> {
      const row = await this.getAgent(id);
      if (!row) return undefined;
      const [count] = await db.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM adh_devices WHERE agent_id = ?',
        [id],
      );
      return rowToAgent(row, Number(count?.count ?? 0));
    },

    async findAgentByToken(token: string): Promise<AgentRow | undefined> {
      const [row] = await db.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM adh_agents WHERE token = ?`,
        [token],
      );
      return row;
    },

    async findAgentByName(name: string): Promise<AgentRow | undefined> {
      const [row] = await db.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM adh_agents WHERE name = ?`,
        [name],
      );
      return row;
    },

    async getAgent(id: string): Promise<AgentRow | undefined> {
      const [row] = await db.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM adh_agents WHERE id = ?`,
        [id],
      );
      return row;
    },

    /** 由 Web 控制台创建，os/arch/version 在首次接入时补齐。 */
    async createAgent(name: string): Promise<AgentRow> {
      const now = Date.now();
      const row: AgentRow = {
        id: randomUUID(),
        name,
        hostName: null,
        os: '',
        arch: '',
        version: '',
        capabilities: '[]',
        token: generateAgentKey(),
        lastSeen: 0,
        createdAt: now,
        tunnelStatus: null,
      };
      await db.execute(
        `INSERT INTO adh_agents
          (id, name, host_name, os, arch, version, capabilities, token, last_seen, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.name,
          row.hostName,
          row.os,
          row.arch,
          row.version,
          row.capabilities,
          row.token,
          row.lastSeen,
          row.createdAt,
        ],
      );
      return row;
    },

    /** server 内置的本机 Agent，每次启动刷新名称与能力。 */
    async ensureBuiltinAgent(
      name: string,
      version: string,
      capabilities: string[],
    ): Promise<AgentRow> {
      const now = Date.now();
      const existing = await this.getAgent(BUILTIN_AGENT_ID);
      if (existing) {
        await db.execute(
          `UPDATE adh_agents
           SET name = ?, host_name = ?, version = ?, capabilities = ?, last_seen = ?
           WHERE id = ?`,
          [name, name, version, JSON.stringify(capabilities), now, BUILTIN_AGENT_ID],
        );
        return { ...existing, name, hostName: name, version, lastSeen: now };
      }

      const row: AgentRow = {
        id: BUILTIN_AGENT_ID,
        name,
        hostName: name,
        os: process.platform === 'win32' ? 'windows' : process.platform,
        arch: process.arch,
        version,
        capabilities: JSON.stringify(capabilities),
        token: generateAgentKey(),
        lastSeen: now,
        createdAt: now,
        tunnelStatus: null,
      };
      await db.execute(
        `INSERT INTO adh_agents
          (id, name, host_name, os, arch, version, capabilities, token, last_seen, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.name,
          row.hostName,
          row.os,
          row.arch,
          row.version,
          row.capabilities,
          row.token,
          row.lastSeen,
          row.createdAt,
        ],
      );
      return row;
    },

    async rotateAgentToken(id: string): Promise<AgentRow | undefined> {
      const token = generateAgentKey();
      await db.execute('UPDATE adh_agents SET token = ? WHERE id = ?', [token, id]);
      return this.getAgent(id);
    },

    /** 重命名；调用方负责检查重名。 */
    async renameAgent(id: string, name: string): Promise<AgentRow | undefined> {
      const existing = await this.getAgent(id);
      if (!existing) return undefined;
      await db.execute('UPDATE adh_agents SET name = ? WHERE id = ?', [name, id]);
      return { ...existing, name };
    },

    async deleteAgent(id: string): Promise<boolean> {
      const existing = await this.getAgent(id);
      if (!existing) return false;
      await db.execute('DELETE FROM adh_agents WHERE id = ?', [id]);
      return true;
    },

    async updateAgentRuntime(id: string, info: AgentRuntimeInfo): Promise<void> {
      // name 是用户可编辑的显示名，这里只记录宿主机上报的原始名称
      await db.execute(
        `UPDATE adh_agents
         SET host_name = ?, os = ?, arch = ?, version = ?, capabilities = ?, last_seen = ?
         WHERE id = ?`,
        [
          info.name,
          info.os,
          info.arch,
          info.version,
          JSON.stringify(info.capabilities),
          Date.now(),
          id,
        ],
      );
    },

    async touchAgent(id: string, at = Date.now()): Promise<void> {
      await db.execute('UPDATE adh_agents SET last_seen = ? WHERE id = ?', [at, id]);
    },

    /** 记录节点上报的 iOS 隧道状态，节点离线时保留最后一次。 */
    async updateAgentTunnel(
      id: string,
      tunnel: IosTunnelStatus,
    ): Promise<void> {
      await db.execute('UPDATE adh_agents SET tunnel_status = ? WHERE id = ?', [
        JSON.stringify(tunnel),
        id,
      ]);
    },

    async listDevices(agentId?: string): Promise<DeviceSummary[]> {
      const rows = agentId
        ? await db.query<DeviceRow>(
            `SELECT ${DEVICE_COLUMNS} FROM adh_devices WHERE agent_id = ?`,
            [agentId],
          )
        : await db.query<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM adh_devices`);
      return rows.map(rowToDevice);
    },

    async getDevice(id: string): Promise<DeviceSummary | undefined> {
      const [row] = await db.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM adh_devices WHERE id = ?`,
        [id],
      );
      return row ? rowToDevice(row) : undefined;
    },

    async findDevice(
      agentId: string,
      udid: string,
    ): Promise<DeviceRow | undefined> {
      const [row] = await db.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM adh_devices WHERE agent_id = ? AND udid = ?`,
        [agentId, udid],
      );
      return row;
    },

    async upsertDevice(agentId: string, info: DeviceInfo): Promise<DeviceSummary> {
      const now = Date.now();
      const existing = await this.findDevice(agentId, info.udid);
      const values = {
        agentId,
        udid: info.udid,
        platform: info.platform,
        name: info.name,
        model: info.model ?? null,
        marketName: info.marketName ?? null,
        brand: info.brand ?? null,
        osVersion: info.osVersion ?? null,
        sdk: info.sdk ?? null,
        cpu: info.cpu ?? null,
        cpuVendor: info.cpuVendor ?? null,
        cpuModel: info.cpuModel ?? null,
        cpuCores: info.cpuCores ?? null,
        cpuArch: info.cpuArch ?? null,
        cpuCode: info.cpuCode ?? null,
        memoryMb: info.memoryMb ?? null,
        rooted: info.rooted === undefined ? null : info.rooted ? 1 : 0,
        resolution: info.resolution ? JSON.stringify(info.resolution) : null,
        status: info.status,
        capabilities: JSON.stringify(info.capabilities),
        tags: JSON.stringify(info.tags),
        lastSeen: now,
      };

      if (existing) {
        await db.execute(
          `UPDATE adh_devices SET
             platform = ?, name = ?, model = ?, market_name = ?, brand = ?,
             os_version = ?, sdk = ?, cpu = ?, cpu_vendor = ?, cpu_model = ?,
             cpu_cores = ?, cpu_arch = ?, cpu_code = ?, memory_mb = ?, rooted = ?, resolution = ?, status = ?,
             capabilities = ?, tags = ?, last_seen = ?
           WHERE id = ?`,
          [
            values.platform,
            values.name,
            values.model,
            values.marketName,
            values.brand,
            values.osVersion,
            values.sdk,
            values.cpu,
            values.cpuVendor,
            values.cpuModel,
            values.cpuCores,
            values.cpuArch,
            values.cpuCode,
            values.memoryMb,
            values.rooted,
            values.resolution,
            values.status,
            values.capabilities,
            values.tags,
            values.lastSeen,
            existing.id,
          ],
        );
        return rowToDevice({ ...existing, ...values });
      }

      const row: DeviceRow = {
        id: randomUUID(),
        thumbnailAt: 0,
        thumbnailSource: 'auto',
        publishedAt: 0,
        safeKeyboard: null,
        locked: 0,
        lockedBy: null,
        lockedAt: 0,
        ...values,
      };
      await db.execute(
        `INSERT INTO adh_devices
          (id, agent_id, udid, platform, name, model, market_name, brand,
           os_version, sdk, cpu, cpu_vendor, cpu_model, cpu_cores, cpu_arch, cpu_code,
           memory_mb, rooted, resolution, status, capabilities, tags, last_seen,
           thumbnail_at, thumbnail_source, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.agentId,
          row.udid,
          row.platform,
          row.name,
          row.model,
          row.marketName,
          row.brand,
          row.osVersion,
          row.sdk,
          row.cpu,
          row.cpuVendor,
          row.cpuModel,
          row.cpuCores,
          row.cpuArch,
          row.cpuCode,
          row.memoryMb,
          row.rooted,
          row.resolution,
          row.status,
          row.capabilities,
          row.tags,
          row.lastSeen,
          row.thumbnailAt,
          row.thumbnailSource,
          row.publishedAt,
        ],
      );
      return rowToDevice(row);
    },

    async patchDevice(
      agentId: string,
      udid: string,
      patch: Partial<DeviceInfo>,
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.findDevice(agentId, udid);
      if (!existing) return undefined;

      const sets: string[] = ['last_seen = ?'];
      const params: unknown[] = [Date.now()];
      const set = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`);
        params.push(value);
      };

      if (patch.name !== undefined) set('name', patch.name);
      if (patch.model !== undefined) set('model', patch.model ?? null);
      if (patch.marketName !== undefined)
        set('market_name', patch.marketName ?? null);
      if (patch.brand !== undefined) set('brand', patch.brand ?? null);
      if (patch.osVersion !== undefined) set('os_version', patch.osVersion ?? null);
      if (patch.sdk !== undefined) set('sdk', patch.sdk ?? null);
      if (patch.cpu !== undefined) set('cpu', patch.cpu ?? null);
      if (patch.cpuVendor !== undefined)
        set('cpu_vendor', patch.cpuVendor ?? null);
      if (patch.cpuModel !== undefined) set('cpu_model', patch.cpuModel ?? null);
      if (patch.cpuCores !== undefined) set('cpu_cores', patch.cpuCores ?? null);
      if (patch.cpuArch !== undefined) set('cpu_arch', patch.cpuArch ?? null);
      if (patch.cpuCode !== undefined) set('cpu_code', patch.cpuCode ?? null);
      if (patch.memoryMb !== undefined) set('memory_mb', patch.memoryMb ?? null);
      if (patch.rooted !== undefined) set('rooted', patch.rooted ? 1 : 0);
      if (patch.status !== undefined) set('status', patch.status);
      if (patch.capabilities !== undefined)
        set('capabilities', JSON.stringify(patch.capabilities));
      if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
      if (patch.resolution !== undefined)
        set(
          'resolution',
          patch.resolution ? JSON.stringify(patch.resolution) : null,
        );

      params.push(existing.id);
      await db.execute(
        `UPDATE adh_devices SET ${sets.join(', ')} WHERE id = ?`,
        params,
      );
      return this.getDevice(existing.id);
    },

    async removeDevice(
      agentId: string,
      udid: string,
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.findDevice(agentId, udid);
      if (!existing) return undefined;
      await db.execute('DELETE FROM adh_devices WHERE id = ?', [existing.id]);
      return rowToDevice(existing);
    },

    async markThumbnail(
      deviceId: string,
      at = Date.now(),
    ): Promise<DeviceSummary | undefined> {
      await db.execute(
        'UPDATE adh_devices SET thumbnail_at = ? WHERE id = ?',
        [at, deviceId],
      );
      return this.getDevice(deviceId);
    },

    /** 手动上传的设备图片，标记后自动截图不再覆盖。 */
    async setManualThumbnail(
      deviceId: string,
    ): Promise<DeviceSummary | undefined> {
      await db.execute(
        "UPDATE adh_devices SET thumbnail_at = ?, thumbnail_source = 'manual' WHERE id = ?",
        [Date.now(), deviceId],
      );
      return this.getDevice(deviceId);
    },

    async updateDeviceMeta(
      id: string,
      patch: {
        publishedAt?: number;
        safeKeyboard?: SafeKeyboardLayout | null;
        locked?: boolean;
        lockedBy?: string | null;
        lockedAt?: number;
      },
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.getDevice(id);
      if (!existing) return undefined;

      const sets: string[] = [];
      const params: unknown[] = [];

      if (patch.publishedAt !== undefined) {
        sets.push('published_at = ?');
        params.push(patch.publishedAt);
      }
      if (patch.safeKeyboard !== undefined) {
        sets.push('safe_keyboard = ?');
        params.push(
          patch.safeKeyboard ? JSON.stringify(patch.safeKeyboard) : null,
        );
      }
      if (patch.locked !== undefined) {
        sets.push('locked = ?');
        params.push(patch.locked ? 1 : 0);
      }
      if (patch.lockedBy !== undefined) {
        sets.push('locked_by = ?');
        params.push(patch.lockedBy);
      }
      if (patch.lockedAt !== undefined) {
        sets.push('locked_at = ?');
        params.push(patch.lockedAt);
      }

      if (sets.length > 0) {
        params.push(id);
        await db.execute(
          `UPDATE adh_devices SET ${sets.join(', ')} WHERE id = ?`,
          params,
        );
      }
      return this.getDevice(id);
    },

    /** 设备从 agent 侧消失时只标记离线，保留记录以便查看历史。 */
    async markDeviceOffline(
      agentId: string,
      udid: string,
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.findDevice(agentId, udid);
      if (!existing) return undefined;
      if (existing.status === 'offline') return rowToDevice(existing);
      await db.execute("UPDATE adh_devices SET status = 'offline' WHERE id = ?", [
        existing.id,
      ]);
      return rowToDevice({ ...existing, status: 'offline' });
    },

    async markAgentDevicesOffline(agentId: string): Promise<DeviceSummary[]> {
      const rows = await db.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM adh_devices WHERE agent_id = ?`,
        [agentId],
      );
      if (rows.length === 0) return [];
      await db.execute(
        "UPDATE adh_devices SET status = 'offline' WHERE agent_id = ?",
        [agentId],
      );
      return rows.map((row) => rowToDevice({ ...row, status: 'offline' }));
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;