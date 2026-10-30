import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  os: text('os').notNull(),
  arch: text('arch').notNull(),
  version: text('version').notNull(),
  capabilities: text('capabilities').notNull().default('[]'),
  token: text('token').notNull().unique(),
  lastSeen: integer('last_seen').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    udid: text('udid').notNull(),
    platform: text('platform').notNull(),
    name: text('name').notNull(),
    model: text('model'),
    osVersion: text('os_version'),
    /** JSON: { width, height } */
    resolution: text('resolution'),
    status: text('status').notNull().default('online'),
    /** JSON: string[] */
    capabilities: text('capabilities').notNull().default('[]'),
    /** JSON: string[] */
    tags: text('tags').notNull().default('[]'),
    lastSeen: integer('last_seen').notNull().default(0),
  },
  (t) => [
    uniqueIndex('devices_agent_udid_idx').on(t.agentId, t.udid),
    index('devices_agent_id_idx').on(t.agentId),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;