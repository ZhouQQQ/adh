import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  AgentRuntimeInfo,
  AgentSummary,
  DeviceInfo,
  DeviceStatus,
  DeviceSummary,
  Platform,
  Resolution,
} from '@adh/protocol';
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

export function rowToAgent(row: AgentRow): AgentSummary {
  return {
    id: row.id,
    name: row.name,
    os: row.os,
    arch: row.arch,
    version: row.version,
    capabilities: parseStringArray(row.capabilities),
    lastSeen: row.lastSeen,
    online: false,
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
  };
  if (row.model) summary.model = row.model;
  if (row.osVersion) summary.osVersion = row.osVersion;
  const resolution = parseResolution(row.resolution);
  if (resolution) summary.resolution = resolution;
  return summary;
}

export interface CreateAgentInput {
  name: string;
  os: string;
  arch: string;
  version: string;
  capabilities: string[];
  token: string;
}

export function createQueries(db: Db) {
  return {
    listAgents(): AgentSummary[] {
      return db.select().from(agents).all().map(rowToAgent);
    },

    findAgentByToken(token: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.token, token)).get();
    },

    findAgentByName(name: string, os: string): AgentRow | undefined {
      return db
        .select()
        .from(agents)
        .where(and(eq(agents.name, name), eq(agents.os, os)))
        .get();
    },

    getAgent(id: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.id, id)).get();
    },

    createAgent(input: CreateAgentInput): AgentRow {
      const row: AgentRow = {
        id: randomUUID(),
        name: input.name,
        os: input.os,
        arch: input.arch,
        version: input.version,
        capabilities: JSON.stringify(input.capabilities),
        token: input.token,
        lastSeen: Date.now(),
        createdAt: Date.now(),
      };
      db.insert(agents).values(row).run();
      return row;
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

    updateAgentToken(id: string, token: string): void {
      db.update(agents).set({ token }).where(eq(agents.id, id)).run();
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
        osVersion: info.osVersion ?? null,
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

      const row: DeviceRow = { id: randomUUID(), ...values };
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
      if (patch.osVersion !== undefined) set.osVersion = patch.osVersion ?? null;
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