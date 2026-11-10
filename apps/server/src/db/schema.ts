/**
 * 数据库行的 TypeScript 结构。
 * SQLite / MySQL 共用一套字段名，时间戳一律是毫秒整数。
 */
export interface AgentRow {
  id: string;
  name: string;
  /** host | portal */
  kind: string;
  /** 直连 App 的稳定实例 ID */
  instanceId: string | null;
  /** 直连 App 的归属用户（用谁的 API Key 连上来的）。 */
  ownerUserId: string | null;
  hostName: string | null;
  os: string;
  arch: string;
  version: string;
  capabilities: string;
  token: string;
  lastSeen: number;
  createdAt: number;
  tunnelStatus: string | null;
}

export interface DeviceRow {
  id: string;
  agentId: string;
  udid: string;
  platform: string;
  name: string;
  model: string | null;
  marketName: string | null;
  brand: string | null;
  osVersion: string | null;
  sdk: number | null;
  cpu: string | null;
  cpuVendor: string | null;
  cpuModel: string | null;
  cpuCores: number | null;
  cpuArch: string | null;
  cpuCode: string | null;
  memoryMb: number | null;
  rooted: number | null;
  resolution: string | null;
  status: string;
  capabilities: string;
  tags: string;
  lastSeen: number;
  connectedAt: number;
  useCount: number;
  lastUsedAt: number;
  thumbnailAt: number;
  thumbnailSource: string;
  publishedAt: number;
  safeKeyboard: string | null;
  locked: number | null;
  lockedBy: string | null;
  lockedAt: number | null;
  /** iOS 设备所在 agent 分配的 WDA 转发端口。 */
  wdaPort: number | null;
}

export interface PackageRow {
  id: string;
  name: string;
  kind: string;
  size: number;
  uploadedAt: number;
  remark: string | null;
  tags: string | null;
}
