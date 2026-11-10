import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { maskKey } from '../db/queries.js';
import type { ApiKeyService } from '../auth/api-keys.js';

/** 直连 APK 的候选路径，按优先级排列。 */
function apkCandidates(): string[] {
  return [
    process.env.ADH_PORTAL_APK,
    // 打包后的 server：<安装目录>/portal/adh-portal.apk
    fileURLToPath(new URL('../../portal/adh-portal.apk', import.meta.url)),
    // 开发环境：仓库里 Gradle 的构建产物
    fileURLToPath(
      new URL(
        '../../../../apps/portal-android/app/build/outputs/apk/debug/app-debug.apk',
        import.meta.url,
      ),
    ),
    fileURLToPath(new URL('../../../../dist/portal/adh-portal.apk', import.meta.url)),
  ].filter((item): item is string => Boolean(item));
}

/** 取第一个实际存在的 APK 文件。 */
function findApk(): string | undefined {
  return apkCandidates().find((item) => fs.existsSync(item));
}

/**
 * 读 APK 旁边 output-metadata.json 里的 versionName。
 * 版本号以实际构建出来的包为准，避免和 build.gradle 漂移。
 */
function readApkVersion(apkPath: string): string | null {
  try {
    const raw = fs.readFileSync(
      path.join(path.dirname(apkPath), 'output-metadata.json'),
      'utf8',
    );
    const meta = JSON.parse(raw) as {
      elements?: Array<{ versionName?: unknown }>;
    };
    const version = meta.elements?.[0]?.versionName;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}

function resolveApkVersion(fallback: string): string {
  for (const candidate of apkCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const version = readApkVersion(candidate);
    if (version) return version;
  }
  return fallback;
}

function lanIpv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
}

function isLoopbackHost(host: string): boolean {
  const name = host.split(':')[0] ?? '';
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

export interface PortalRoutesDeps {
  apiKeys: ApiKeyService;
  port: number;
  basePath: string;
  /** 读不到 APK 元数据时的版本兜底。 */
  version: string;
}

/** 设备直连：用当前用户自己的 API Key 配对，地址里带上这把 Key。 */
export function registerPortalRoutes(
  app: FastifyInstance,
  deps: PortalRoutesDeps,
): void {
  app.get('/api/portal/info', async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '请先登录' });
    // 直连用的是登录用户自己的 Key，谁连的手机在节点 / 设备列表里就能看出来
    const current = await deps.apiKeys.ensureForUser(user.id);
    const key = current.key;
    const forwardedHost = String(
      request.headers['x-forwarded-host'] ?? '',
    )
      .split(',')[0]
      ?.trim();
    const rawHost = forwardedHost || request.headers.host || `127.0.0.1:${deps.port}`;
    const host = isLoopbackHost(rawHost)
      ? `${lanIpv4() ?? '127.0.0.1'}:${deps.port}`
      : rawHost;
    const forwardedProto = String(
      request.headers['x-forwarded-proto'] ?? '',
    )
      .split(',')[0]
      ?.trim();
    const secure = forwardedProto === 'https' || request.protocol === 'https';
    const scheme = secure ? 'wss' : 'ws';
    const prefix = deps.basePath.replace(/\/+$/, '');

    return {
      key,
      keyPreview: maskKey(key),
      port: deps.port,
      lanIp: lanIpv4(),
      address: `${scheme}://${host}${prefix}?key=${key}`,
      android: {
        available: Boolean(findApk()),
        url: '/api/portal/download/android',
        version: resolveApkVersion(deps.version),
      },
      ios: {
        available: false,
        note: 'iOS 不允许第三方 App 注入触摸到其他 App，无法做设备无线直连；请使用宿主机 Agent + WDA。',
      },
    };
  });

  app.get('/api/portal/download/android', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: '请先登录' });
    const file = findApk();
    if (!file) {
      return reply.code(404).send({
        error: '直连 APK 尚未构建，请先执行 pnpm portal:build',
      });
    }
    const data = fs.readFileSync(file);
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', 'attachment; filename="adh-portal.apk"')
      .header('content-length', String(data.length))
      .header('cache-control', 'no-store')
      .send(data);
  });
}
