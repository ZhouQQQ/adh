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
    os: row.os,
    arch: row.arch,
    version: row.version,
    capabilities: parseStringArray(row.capabilities),
    keyPreview: maskKey(row.token),
    deviceCount,
    lastSeen: row.lastSeen,
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
  };
  if (row.model) summary.model = row.model;
  if (row.brand) summary.brand = row.brand;
  if (row.osVersion) summary.osVersion = row.osVersion;
  if (row.sdk != null) summary.sdk = row.sdk;
  if (row.cpu) summary.cpu = row.cpu;
  if (row.cpuCores != null) summary.cpuCores = row.cpuCores;
  if (row.memoryMb != null) summary.memoryMb = row.memoryMb;
  const resolution = parseResolution(row.resolution);
  if (resolution) summary.resolution = resolution;
  return summary;
}

export function createQueries(db: Db) {
  const deviceCounts = (): Map<string, number> => {
    const rows = db
      .select({
        agentId: devices.agentId,
        count: sql<number>`count(*)`,
      })
      .from(devices)
      .groupBy(devices.agentId)
      .all();
    return new Map(rows.map((row) => [row.agentId, Number(row.count)]));
  };

  return {
    listAgents(): AgentSummary[] {
      const counts = deviceCounts();
      return db
        .select()
        .from(agents)
        .all()
        .map((row) => rowToAgent(row, counts.get(row.id) ?? 0));
    },

    getAgentSummary(id: string): AgentSummary | undefined {
      const row = db.select().from(agents).where(eq(agents.id, id)).get();
      if (!row) return undefined;
      const count = db
        .select({ count: sql<number>`count(*)` })
        .from(devices)
        .where(eq(devices.agentId, id))
        .get();
      return rowToAgent(row, Number(count?.count ?? 0));
    },

    findAgentByToken(token: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.token, token)).get();
    },

    findAgentByName(name: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.name, name)).get();
    },

    getAgent(id: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.id, id)).get();
    },

    /** 由 Web 控制台创建，os/arch/version 在首次接入时补齐。 */
    createAgent(name: string): AgentRow {
      const now = Date.now();
      const row: AgentRow = {
        id: randomUUID(),
        name,
        os: '',
        arch: '',
        version: '',
        capabilities: '[]',
        token: generateAgentKey(),
        lastSeen: 0,
        createdAt: now,
      };
      db.insert(agents).values(row).run();
      return row;
    },

    /** server 内置的本机 Agent，每次启动刷新名称与能力。 */
    ensureBuiltinAgent(
      name: string,
      version: string,
      capabilities: string[],
    ): AgentRow {
      const now = Date.now();
      const existing = this.getAgent(BUILTIN_AGENT_ID);
      if (existing) {
        db.update(agents)
          .set({
            name,
            version,
            capabilities: JSON.stringify(capabilities),
            lastSeen: now,
          })
          .where(eq(agents.id, BUILTIN_AGENT_ID))
          .run();
        return { ...existing, name, version, lastSeen: now };
      }

      const row: AgentRow = {
        id: BUILTIN_AGENT_ID,
        name,
        os: process.platform === 'win32' ? 'windows' : process.platform,
        arch: process.arch,
        version,
        capabilities: JSON.stringify(capabilities),
        token: generateAgentKey(),
        lastSeen: now,
        createdAt: now,
      };
      db.insert(agents).values(row).run();
      return row;
    },

    rotateAgentToken(id: string): AgentRow | undefined {
      const token = generateAgentKey();
      db.update(agents).set({ token }).where(eq(agents.id, id)).run();
      return this.getAgent(id);
    },

    deleteAgent(id: string): boolean {
      const existing = this.getAgent(id);
      if (!existing) return false;
      db.delete(agents).where(eq(agents.id, id)).run();
      return true;
    },

    updateAgentRuntime(id: string, info: AgentRuntimeInfo): void {
      db.update(agents)
        .set({
          name: info.name,
          os: info.os,
          arch: info.arch,
          version: info.version,
          capabilities: JSON.stringify(info.capabilities),
          lastSeen: Date.now(),
        })
        .where(eq(agents.id, id))
        .run();
    },

    touchAgent(id: string, at = Date.now()): void {
      db.update(agents).set({ lastSeen: at }).where(eq(agents.id, id)).run();
    },

    listDevices(agentId?: string): DeviceSummary[] {
      const rows = agentId
        ? db.select().from(devices).where(eq(devices.agentId, agentId)).all()
        : db.select().from(devices).all();
      return rows.map(rowToDevice);
    },

    getDevice(id: string): DeviceSummary | undefined {
      const row = db.select().from(devices).where(eq(devices.id, id)).get();
      return row ? rowToDevice(row) : undefined;
    },

    findDevice(agentId: string, udid: string): DeviceRow | undefined {
      return db
        .select()
        .from(devices)
        .where(and(eq(devices.agentId, agentId), eq(devices.udid, udid)))
        .get();
    },

    upsertDevice(agentId: string, info: DeviceInfo): DeviceSummary {
      const now = Date.now();
      const existing = this.findDevice(agentId, info.udid);
      const values = {
        agentId,
        udid: info.udid,
        platform: info.platform,
        name: info.name,
        model: info.model ?? null,
        brand: info.brand ?? null,
        osVersion: info.osVersion ?? null,
        sdk: info.sdk ?? null,
        cpu: info.cpu ?? null,
        cpuCores: info.cpuCores ?? null,
        memoryMb: info.memoryMb ?? null,
        resolution: info.resolution ? JSON.stringify(info.resolution) : null,
        status: info.status,
        capabilities: JSON.stringify(info.capabilities),
        tags: JSON.stringify(info.tags),
        lastSeen: now,
      };

      if (existing) {
        db.update(devices).set(values).where(eq(devices.id, existing.id)).run();
        return rowToDevice({ ...existing, ...values });
      }

      const row: DeviceRow = { id: randomUUID(), thumbnailAt: 0, ...values };
      db.insert(devices).values(row).run();
      return rowToDevice(row);
    },

    patchDevice(
      agentId: string,
      udid: string,
      patch: Partial<DeviceInfo>,
    ): DeviceSummary | undefined {
      const existing = this.findDevice(agentId, udid);
      if (!existing) return undefined;
      const set: Partial<DeviceRow> = { lastSeen: Date.now() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.model !== undefined) set.model = patch.model ?? null;
      if (patch.brand !== undefined) set.brand = patch.brand ?? null;
      if (patch.osVersion !== undefined) set.osVersion = patch.osVersion ?? null;
      if (patch.sdk !== undefined) set.sdk = patch.sdk ?? null;
      if (patch.cpu !== undefined) set.cpu = patch.cpu ?? null;
      if (patch.cpuCores !== undefined) set.cpuCores = patch.cpuCores ?? null;
      if (patch.memoryMb !== undefined) set.memoryMb = patch.memoryMb ?? null;
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.capabilities !== undefined)
        set.capabilities = JSON.stringify(patch.capabilities);
      if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
      if (patch.resolution !== undefined)
        set.resolution = patch.resolution ? JSON.stringify(patch.resolution) : null;
      db.update(devices).set(set).where(eq(devices.id, existing.id)).run();
      const updated = db.select().from(devices).where(eq(devices.id, existing.id)).get();
      return updated ? rowToDevice(updated) : undefined;
    },

    removeDevice(agentId: string, udid: string): DeviceSummary | undefined {
      const existing = this.findDevice(agentId, udid);
      if (!existing) return undefined;
      db.delete(devices).where(eq(devices.id, existing.id)).run();
      return rowToDevice(existing);
    },

    markThumbnail(deviceId: string, at = Date.now()): DeviceSummary | undefined {
      db.update(devices)
        .set({ thumbnailAt: at })
        .where(eq(devices.id, deviceId))
        .run();
      const row = db.select().from(devices).where(eq(devices.id, deviceId)).get();
      return row ? rowToDevice(row) : undefined;
    },

    markAgentDevicesOffline(agentId: string): DeviceSummary[] {
      const rows = db.select().from(devices).where(eq(devices.agentId, agentId)).all();
      if (rows.length === 0) return [];
      db.update(devices)
        .set({ status: 'offline' })
        .where(eq(devices.agentId, agentId))
        .run();
      return rows.map((row) => rowToDevice({ ...row, status: 'offline' }));
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;