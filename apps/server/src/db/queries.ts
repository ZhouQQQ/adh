import { and, eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentRuntimeInfo,
  AgentSummary,
  DeviceInfo,
  DeviceStatus,
  DeviceSummary,
  Platform,
  Resolution,
} from '@adh/protocol';
import { BUILTIN_AGENT_ID } from '@adh/protocol';
import type { Db } from './index.js';
import { agents, devices, type AgentRow, type DeviceRow } from './schema.js';

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

export function maskKey(key: string): string {
  if (key.length <= 18) return key;
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}

/** Agent 接入凭证：adh_ 前缀 + 32 位 hex。 */
export function generateAgentKey(): string {
  return `adh_${randomBytes(16).toString('hex')}`;
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
    lastSeen: row.lastSeen,
    createdAt: row.createdAt,
    online: false,
    pending: row.lastSeen === 0,
    builtin: row.id === BUILTIN_AGENT_ID,
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
    lastSeen: row.lastSeen,
    thumbnailAt: row.thumbnailAt ?? 0,
    thumbnailSource: (row.thumbnailSource as 'auto' | 'manual') ?? 'auto',
    publishedAt: row.publishedAt ?? 0,
    inUse: false,
  };
  if (row.model) summary.model = row.model;
  if (row.marketName) summary.marketName = row.marketName;
  if (row.brand) summary.brand = row.brand;
  if (row.osVersion) summary.osVersion = row.osVersion;
  if (row.sdk != null) summary.sdk = row.sdk;
  if (row.cpu) summary.cpu = row.cpu;
  if (row.cpuVendor) summary.cpuVendor = row.cpuVendor;
  if (row.cpuModel) summary.cpuModel = row.cpuModel;
  if (row.cpuCores != null) summary.cpuCores = row.cpuCores;
  if (row.memoryMb != null) summary.memoryMb = row.memoryMb;
  const resolution = parseResolution(row.resolution);
  if (resolution) summary.resolution = resolution;
  return summary;
}

export function createQueries(db: Db) {
  const deviceCounts = async (): Promise<Map<string, number>> => {
    const rows = await db
      .select({
        agentId: devices.agentId,
        count: sql<number>`count(*)`,
      })
      .from(devices)
      .groupBy(devices.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.count)]));
  };

  return {
    async listAgents(): Promise<AgentSummary[]> {
      const counts = await deviceCounts();
      const rows = await db.select().from(agents);
      return rows.map((row) => rowToAgent(row, counts.get(row.id) ?? 0));
    },

    async getAgentSummary(id: string): Promise<AgentSummary | undefined> {
      const [row] = await db.select().from(agents).where(eq(agents.id, id));
      if (!row) return undefined;
      const [count] = await db
        .select({ count: sql<number>`count(*)` })
        .from(devices)
        .where(eq(devices.agentId, id));
      return rowToAgent(row, Number(count?.count ?? 0));
    },

    async findAgentByToken(token: string): Promise<AgentRow | undefined> {
      const [row] = await db
        .select()
        .from(agents)
        .where(eq(agents.token, token));
      return row;
    },

    async findAgentByName(name: string): Promise<AgentRow | undefined> {
      const [row] = await db.select().from(agents).where(eq(agents.name, name));
      return row;
    },

    async getAgent(id: string): Promise<AgentRow | undefined> {
      const [row] = await db.select().from(agents).where(eq(agents.id, id));
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
      };
      await db.insert(agents).values(row);
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
        await db
          .update(agents)
          .set({
            name,
            hostName: name,
            version,
            capabilities: JSON.stringify(capabilities),
            lastSeen: now,
          })
          .where(eq(agents.id, BUILTIN_AGENT_ID));
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
      };
      await db.insert(agents).values(row);
      return row;
    },

    async rotateAgentToken(id: string): Promise<AgentRow | undefined> {
      const token = generateAgentKey();
      await db.update(agents).set({ token }).where(eq(agents.id, id));
      return this.getAgent(id);
    },

    /** 重命名；调用方负责检查重名。 */
    async renameAgent(id: string, name: string): Promise<AgentRow | undefined> {
      const existing = await this.getAgent(id);
      if (!existing) return undefined;
      await db.update(agents).set({ name }).where(eq(agents.id, id));
      return { ...existing, name };
    },

    async deleteAgent(id: string): Promise<boolean> {
      const existing = await this.getAgent(id);
      if (!existing) return false;
      await db.delete(agents).where(eq(agents.id, id));
      return true;
    },

    async updateAgentRuntime(id: string, info: AgentRuntimeInfo): Promise<void> {
      // name 是用户可编辑的显示名，这里只记录宿主机上报的原始名称
      await db
        .update(agents)
        .set({
          hostName: info.name,
          os: info.os,
          arch: info.arch,
          version: info.version,
          capabilities: JSON.stringify(info.capabilities),
          lastSeen: Date.now(),
        })
        .where(eq(agents.id, id));
    },

    async touchAgent(id: string, at = Date.now()): Promise<void> {
      await db.update(agents).set({ lastSeen: at }).where(eq(agents.id, id));
    },

    async listDevices(agentId?: string): Promise<DeviceSummary[]> {
      const rows = agentId
        ? await db.select().from(devices).where(eq(devices.agentId, agentId))
        : await db.select().from(devices);
      return rows.map(rowToDevice);
    },

    async getDevice(id: string): Promise<DeviceSummary | undefined> {
      const [row] = await db.select().from(devices).where(eq(devices.id, id));
      return row ? rowToDevice(row) : undefined;
    },

    async findDevice(
      agentId: string,
      udid: string,
    ): Promise<DeviceRow | undefined> {
      const [row] = await db
        .select()
        .from(devices)
        .where(and(eq(devices.agentId, agentId), eq(devices.udid, udid)));
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
        memoryMb: info.memoryMb ?? null,
        resolution: info.resolution ? JSON.stringify(info.resolution) : null,
        status: info.status,
        capabilities: JSON.stringify(info.capabilities),
        tags: JSON.stringify(info.tags),
        lastSeen: now,
      };

      if (existing) {
        await db.update(devices).set(values).where(eq(devices.id, existing.id));
        return rowToDevice({ ...existing, ...values });
      }

      const row: DeviceRow = {
        id: randomUUID(),
        thumbnailAt: 0,
        thumbnailSource: 'auto',
        publishedAt: 0,
        ...values,
      };
      await db.insert(devices).values(row);
      return rowToDevice(row);
    },

    async patchDevice(
      agentId: string,
      udid: string,
      patch: Partial<DeviceInfo>,
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.findDevice(agentId, udid);
      if (!existing) return undefined;
      const set: Partial<DeviceRow> = { lastSeen: Date.now() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.model !== undefined) set.model = patch.model ?? null;
      if (patch.marketName !== undefined) set.marketName = patch.marketName ?? null;
      if (patch.brand !== undefined) set.brand = patch.brand ?? null;
      if (patch.osVersion !== undefined) set.osVersion = patch.osVersion ?? null;
      if (patch.sdk !== undefined) set.sdk = patch.sdk ?? null;
      if (patch.cpu !== undefined) set.cpu = patch.cpu ?? null;
      if (patch.cpuVendor !== undefined) set.cpuVendor = patch.cpuVendor ?? null;
      if (patch.cpuModel !== undefined) set.cpuModel = patch.cpuModel ?? null;
      if (patch.cpuCores !== undefined) set.cpuCores = patch.cpuCores ?? null;
      if (patch.memoryMb !== undefined) set.memoryMb = patch.memoryMb ?? null;
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.capabilities !== undefined)
        set.capabilities = JSON.stringify(patch.capabilities);
      if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
      if (patch.resolution !== undefined)
        set.resolution = patch.resolution ? JSON.stringify(patch.resolution) : null;
      await db.update(devices).set(set).where(eq(devices.id, existing.id));
      const [updated] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, existing.id));
      return updated ? rowToDevice(updated) : undefined;
    },

    async removeDevice(
      agentId: string,
      udid: string,
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.findDevice(agentId, udid);
      if (!existing) return undefined;
      await db.delete(devices).where(eq(devices.id, existing.id));
      return rowToDevice(existing);
    },

    async markThumbnail(
      deviceId: string,
      at = Date.now(),
    ): Promise<DeviceSummary | undefined> {
      await db
        .update(devices)
        .set({ thumbnailAt: at })
        .where(eq(devices.id, deviceId));
      const [row] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId));
      return row ? rowToDevice(row) : undefined;
    },

    /** 手动上传的设备图片，标记后自动截图不再覆盖。 */
    async setManualThumbnail(
      deviceId: string,
    ): Promise<DeviceSummary | undefined> {
      await db
        .update(devices)
        .set({ thumbnailAt: Date.now(), thumbnailSource: 'manual' })
        .where(eq(devices.id, deviceId));
      const [row] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId));
      return row ? rowToDevice(row) : undefined;
    },

    async updateDeviceMeta(
      id: string,
      patch: { publishedAt?: number },
    ): Promise<DeviceSummary | undefined> {
      const [existing] = await db.select().from(devices).where(eq(devices.id, id));
      if (!existing) return undefined;

      const set: Partial<DeviceRow> = {};
      if (patch.publishedAt !== undefined) set.publishedAt = patch.publishedAt;

      if (Object.keys(set).length > 0) {
        await db.update(devices).set(set).where(eq(devices.id, id));
      }
      const [row] = await db.select().from(devices).where(eq(devices.id, id));
      return row ? rowToDevice(row) : undefined;
    },

    /** 设备从 agent 侧消失时只标记离线，保留记录以便查看历史。 */
    async markDeviceOffline(
      agentId: string,
      udid: string,
    ): Promise<DeviceSummary | undefined> {
      const existing = await this.findDevice(agentId, udid);
      if (!existing) return undefined;
      if (existing.status === 'offline') return rowToDevice(existing);
      await db
        .update(devices)
        .set({ status: 'offline' })
        .where(eq(devices.id, existing.id));
      return rowToDevice({ ...existing, status: 'offline' });
    },

    async markAgentDevicesOffline(agentId: string): Promise<DeviceSummary[]> {
      const rows = await db
        .select()
        .from(devices)
        .where(eq(devices.agentId, agentId));
      if (rows.length === 0) return [];
      await db
        .update(devices)
        .set({ status: 'offline' })
        .where(eq(devices.agentId, agentId));
      return rows.map((row) => rowToDevice({ ...row, status: 'offline' }));
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;