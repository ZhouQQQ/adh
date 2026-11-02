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
  /** agent 上报的宿主机名，name 是用户可编辑的显示名。 */
  hostName: text('host_name'),
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
    marketName: text('market_name'),
    brand: text('brand'),
    osVersion: text('os_version'),
    sdk: integer('sdk'),
    cpu: text('cpu'),
    cpuVendor: text('cpu_vendor'),
    cpuModel: text('cpu_model'),
    cpuCores: integer('cpu_cores'),
    memoryMb: integer('memory_mb'),
    /** JSON: { width, height } */
    resolution: text('resolution'),
    status: text('status').notNull().default('online'),
    /** JSON: string[] */
    capabilities: text('capabilities').notNull().default('[]'),
    /** JSON: string[] */
    tags: text('tags').notNull().default('[]'),
    lastSeen: integer('last_seen').notNull().default(0),
    /** 缩略图最后更新时间（毫秒），0 表示没有。 */
    thumbnailAt: integer('thumbnail_at').notNull().default(0),
    /** auto / manual */
    thumbnailSource: text('thumbnail_source').notNull().default('auto'),
    /** 发布时间（毫秒时间戳），0 表示未设置。 */
    publishedAt: integer('published_at').notNull().default(0),
  },
  (t) => [
    uniqueIndex('devices_agent_udid_idx').on(t.agentId, t.udid),
    index('devices_agent_id_idx').on(t.agentId),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;