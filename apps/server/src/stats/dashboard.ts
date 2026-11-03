import type { SqlDriver } from '../db/driver.js';
import type { Queries } from '../db/queries.js';
import type { PackageStore } from '../storage/packages.js';
import type { StreamManager } from '../stream/manager.js';
import type { AgentRegistry } from '../registry.js';
import { BUILTIN_AGENT_ID } from '@adh/protocol';

export interface DashboardData {
  users: { total: number; admins: number; enabled: number };
  devices: {
    total: number;
    online: number;
    offline: number;
    unauthorized: number;
    locked: number;
    inUse: number;
    /** 已填写发布时间的设备，平均已经发布了多少天；没有数据时为 null。 */
    avgAgeDays: number | null;
    publishedCount: number;
  };
  agents: { total: number; online: number };
  packages: { total: number; apk: number; ipa: number; totalSize: number };
  usage: {
    /** 统计窗口（天） */
    windowDays: number;
    sessions: number;
    seconds: number;
    todaySessions: number;
    todaySeconds: number;
    todayUsers: number;
    /** 近 7 天有控制记录的用户数。 */
    weekUsers: number;
    /** 统计窗口内有控制记录的用户数。 */
    monthUsers: number;
  };
  deviceRanking: Array<{
    deviceId: string;
    deviceName: string;
    sessions: number;
    seconds: number;
  }>;
  userRanking: Array<{
    username: string;
    displayName: string | null;
    sessions: number;
    seconds: number;
  }>;
  daily: Array<{ date: string; sessions: number; seconds: number }>;
  recent: Array<{
    deviceName: string | null;
    username: string | null;
    displayName: string | null;
    action: string;
    createdAt: number;
  }>;
}

export interface DashboardDeps {
  db: SqlDriver;
  queries: Queries;
  packages: PackageStore;
  streams: StreamManager;
  registry: AgentRegistry;
}

/** 单次控制时长上限，避免页面直接关闭导致没有 stop 时算出天文数字。 */
const MAX_SESSION_MS = 6 * 60 * 60 * 1000;
const USAGE_WINDOW_DAYS = 30;
const TREND_DAYS = 7;

interface LogRow {
  deviceId: string | null;
  deviceName: string | null;
  username: string | null;
  action: string;
  createdAt: number;
}

interface Session {
  deviceId: string;
  deviceName: string;
  username: string | null;
  start: number;
  ms: number;
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 把 start / stop 日志配成控制会话；takeover 视为新的开始。 */
function buildSessions(rows: LogRow[]): Session[] {
  const open = new Map<
    string,
    { at: number; username: string | null; deviceName: string }
  >();
  const sessions: Session[] = [];

  const close = (key: string, end: number): void => {
    const started = open.get(key);
    if (!started) return;
    open.delete(key);
    const ms = Math.min(Math.max(0, end - started.at), MAX_SESSION_MS);
    sessions.push({
      deviceId: key,
      deviceName: started.deviceName,
      username: started.username,
      start: started.at,
      ms,
    });
  };

  for (const row of rows) {
    const key = row.deviceId ?? row.deviceName ?? 'unknown';
    if (row.action === 'control.start' || row.action === 'control.takeover') {
      // 接管时先把上一段结算掉
      close(key, row.createdAt);
      open.set(key, {
        at: row.createdAt,
        username: row.username,
        deviceName: row.deviceName ?? key,
      });
      continue;
    }
    if (row.action === 'control.stop' || row.action === 'control.kick') {
      close(key, row.createdAt);
    }
  }

  return sessions;
}

export async function loadDashboard(deps: DashboardDeps): Promise<DashboardData> {
  const now = Date.now();
  const since = now - USAGE_WINDOW_DAYS * 86_400_000;
  const today = startOfToday();

  const [
    userTotal,
    userAdmins,
    userEnabled,
    deviceRows,
    lockedRow,
    logRows,
    agents,
    packages,
  ] = await Promise.all([
    deps.db.query<{ total: number }>('SELECT COUNT(*) AS total FROM adh_users'),
    deps.db.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM adh_users WHERE role = 'admin'",
    ),
    deps.db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM adh_users WHERE enabled = 1',
    ),
    deps.db.query<{ status: string; total: number }>(
      'SELECT status, COUNT(*) AS total FROM adh_devices GROUP BY status',
    ),
    deps.db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM adh_devices WHERE locked = 1',
    ),
    deps.db.query<LogRow>(
      `SELECT device_id AS deviceId, device_name AS deviceName,
              username, action, created_at AS createdAt
       FROM adh_device_logs
       WHERE created_at >= ?
         AND action IN ('control.start','control.stop','control.takeover','control.kick')
       ORDER BY created_at ASC`,
      [since],
    ),
    deps.queries.listAgents(),
    deps.packages.list(),
  ]);

  const sessions = buildSessions(logRows);

  const deviceRanking = new Map<
    string,
    { deviceName: string; sessions: number; ms: number }
  >();
  const userRanking = new Map<string, { sessions: number; ms: number }>();
  const daily = new Map<string, { sessions: number; ms: number }>();
  for (let i = TREND_DAYS - 1; i >= 0; i -= 1) {
    daily.set(dayKey(now - i * 86_400_000), { sessions: 0, ms: 0 });
  }

  let totalMs = 0;
  let todayMs = 0;
  let todaySessions = 0;
  const todayUsers = new Set<string>();
  const weekUsers = new Set<string>();
  const monthUsers = new Set<string>();
  const weekStart = now - TREND_DAYS * 86_400_000;

  for (const session of sessions) {
    totalMs += session.ms;

    const device = deviceRanking.get(session.deviceId) ?? {
      deviceName: session.deviceName,
      sessions: 0,
      ms: 0,
    };
    device.sessions += 1;
    device.ms += session.ms;
    deviceRanking.set(session.deviceId, device);

    if (session.username) {
      const user = userRanking.get(session.username) ?? { sessions: 0, ms: 0 };
      user.sessions += 1;
      user.ms += session.ms;
      userRanking.set(session.username, user);

      monthUsers.add(session.username);
      if (session.start >= weekStart) weekUsers.add(session.username);
    }

    const key = dayKey(session.start);
    const bucket = daily.get(key);
    if (bucket) {
      bucket.sessions += 1;
      bucket.ms += session.ms;
    }

    if (session.start >= today) {
      todaySessions += 1;
      todayMs += session.ms;
      if (session.username) todayUsers.add(session.username);
    }
  }

  const [deviceList, userRows] = await Promise.all([
    deps.queries.listDevices(),
    deps.db.query<{ username: string; displayName: string | null }>(
      'SELECT username, display_name AS displayName FROM adh_users',
    ),
  ]);
  const deviceNames = new Map(deviceList.map((device) => [device.id, device.name]));
  const displayNames = new Map(
    userRows.map((user) => [user.username, user.displayName]),
  );

  const statusCount = (status: string): number =>
    Number(deviceRows.find((row) => row.status === status)?.total ?? 0);

  // 设备平均年龄：只统计填了发布时间的设备
  const published = deviceList.filter((device) => device.publishedAt > 0);
  const avgAgeDays =
    published.length > 0
      ? Math.round(
          (now -
            published.reduce((sum, device) => sum + device.publishedAt, 0) /
              published.length) /
            86_400_000,
        )
      : null;
  const deviceAge = { days: avgAgeDays, count: published.length };

  const totalDevices = deviceRows.reduce(
    (sum, row) => sum + Number(row.total),
    0,
  );

  const recent = await deps.db.query<{
    deviceName: string | null;
    username: string | null;
    displayName: string | null;
    action: string;
    createdAt: number;
  }>(
    `SELECT l.device_name AS deviceName, l.username,
            u.display_name AS displayName, l.action,
            l.created_at AS createdAt
     FROM adh_device_logs l
     LEFT JOIN adh_users u ON u.username = l.username
     WHERE l.action <> 'input.touch'
     ORDER BY l.created_at DESC
     LIMIT 12`,
  );

  return {
    users: {
      total: Number(userTotal[0]?.total ?? 0),
      admins: Number(userAdmins[0]?.total ?? 0),
      enabled: Number(userEnabled[0]?.total ?? 0),
    },
    devices: {
      total: totalDevices,
      online: statusCount('online'),
      offline: statusCount('offline'),
      unauthorized: statusCount('unauthorized'),
      locked: Number(lockedRow[0]?.total ?? 0),
      inUse: deps.streams.listInUseDeviceIds().length,
      avgAgeDays: deviceAge.days,
      publishedCount: deviceAge.count,
    },
    agents: {
      total: agents.length,
      online: agents.filter(
        (agent) => agent.id === BUILTIN_AGENT_ID || deps.registry.get(agent.id),
      ).length,
    },
    packages: {
      total: packages.length,
      apk: packages.filter((item) => item.kind === 'apk').length,
      ipa: packages.filter((item) => item.kind === 'ipa').length,
      totalSize: packages.reduce((sum, item) => sum + item.size, 0),
    },
    usage: {
      windowDays: USAGE_WINDOW_DAYS,
      sessions: sessions.length,
      seconds: Math.round(totalMs / 1000),
      todaySessions,
      todaySeconds: Math.round(todayMs / 1000),
      todayUsers: todayUsers.size,
      weekUsers: weekUsers.size,
      monthUsers: monthUsers.size,
    },
    deviceRanking: [...deviceRanking.entries()]
      .map(([deviceId, value]) => ({
        deviceId,
        deviceName: deviceNames.get(deviceId) ?? value.deviceName ?? deviceId,
        sessions: value.sessions,
        seconds: Math.round(value.ms / 1000),
      }))
      .sort((a, b) => b.seconds - a.seconds || b.sessions - a.sessions)
      .slice(0, 10),
    userRanking: [...userRanking.entries()]
      .map(([username, value]) => ({
        username,
        displayName: displayNames.get(username) ?? null,
        sessions: value.sessions,
        seconds: Math.round(value.ms / 1000),
      }))
      .sort((a, b) => b.seconds - a.seconds || b.sessions - a.sessions)
      .slice(0, 8),
    daily: [...daily.entries()].map(([date, value]) => ({
      date,
      sessions: value.sessions,
      seconds: Math.round(value.ms / 1000),
    })),
    recent: recent.map((row) => ({
      deviceName: row.deviceName,
      username: row.username,
      displayName: row.displayName,
      action: row.action,
      createdAt: Number(row.createdAt),
    })),
  };
}