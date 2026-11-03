/**
 * 数据库行的 TypeScript 结构。
 * SQLite / MySQL 共用一套字段名，时间戳一律是毫秒整数。
 */
export interface AgentRow {
  id: string;
  name: string;
  hostName: string | null;
  os: string;
  arch: string;
  version: string;
  capabilities: string;
  token: string;
  lastSeen: number;
  createdAt: number;
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
  thumbnailAt: number;
  thumbnailSource: string;
  publishedAt: number;
  safeKeyboard: string | null;
}

export interface PackageRow {
  id: string;
  name: string;
  kind: string;
  size: number;
  uploadedAt: number;
}