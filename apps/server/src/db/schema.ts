import {
  bigint,
  index,
  int,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * MySQL 表结构。
 * 时间戳一律存毫秒整数（BIGINT），布尔值用 0/1，JSON 字段直接存 TEXT。
 */
export const agents = mysqlTable('adh_agents', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 191 }).notNull(),
  /** agent 上报的宿主机名，name 是用户可编辑的显示名。 */
  hostName: varchar('host_name', { length: 191 }),
  os: varchar('os', { length: 32 }).notNull(),
  arch: varchar('arch', { length: 32 }).notNull(),
  version: varchar('version', { length: 64 }).notNull(),
  capabilities: text('capabilities').notNull(),
  token: varchar('token', { length: 128 }).notNull(),
  lastSeen: bigint('last_seen', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const devices = mysqlTable(
  'adh_devices',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    agentId: varchar('agent_id', { length: 64 }).notNull(),
    udid: varchar('udid', { length: 191 }).notNull(),
    platform: varchar('platform', { length: 32 }).notNull(),
    name: varchar('name', { length: 191 }).notNull(),
    model: varchar('model', { length: 191 }),
    marketName: varchar('market_name', { length: 191 }),
    brand: varchar('brand', { length: 191 }),
    osVersion: varchar('os_version', { length: 64 }),
    sdk: int('sdk'),
    cpu: varchar('cpu', { length: 191 }),
    cpuVendor: varchar('cpu_vendor', { length: 191 }),
    cpuModel: varchar('cpu_model', { length: 191 }),
    cpuCores: int('cpu_cores'),
    memoryMb: int('memory_mb'),
    /** JSON: { width, height } */
    resolution: varchar('resolution', { length: 64 }),
    status: varchar('status', { length: 32 }).notNull(),
    /** JSON: string[] */
    capabilities: text('capabilities').notNull(),
    /** JSON: string[] */
    tags: text('tags').notNull(),
    lastSeen: bigint('last_seen', { mode: 'number' }).notNull().default(0),
    /** 缩略图最后更新时间（毫秒），0 表示没有。 */
    thumbnailAt: bigint('thumbnail_at', { mode: 'number' }).notNull().default(0),
    /** auto / manual */
    thumbnailSource: varchar('thumbnail_source', { length: 16 }).notNull(),
    /** 发布时间（毫秒时间戳），0 表示未设置。 */
    publishedAt: bigint('published_at', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('adh_devices_agent_udid_idx').on(t.agentId, t.udid),
    index('adh_devices_agent_id_idx').on(t.agentId),
  ],
);

/** 应用管理里的安装包元数据，文件本体存在 data/packages 下。 */
export const packages = mysqlTable(
  'adh_packages',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    /** apk / ipa */
    kind: varchar('kind', { length: 8 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    uploadedAt: bigint('uploaded_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('adh_packages_uploaded_at_idx').on(t.uploadedAt)],
);

export type AgentRow = typeof agents.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type PackageRow = typeof packages.$inferSelect;