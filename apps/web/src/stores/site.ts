import { ref } from 'vue';
import { api } from '../api';
import { withBase } from '../base';

/** 站点标题、副标题与 Logo，登录页和侧边栏共用。 */
const title = ref('设备农场');
const subtitle = ref('Device Hub');
const logoUpdatedAt = ref(0);
/** 普通用户可同时控制的设备数，0 表示不限。 */
const operatorDeviceLimit = ref(1);
/** 管理员可同时控制的设备数，0 表示不限。 */
const adminDeviceLimit = ref(0);
/** 超级管理员可同时控制的设备数，0 表示不限。 */
const superadminDeviceLimit = ref(0);

/**
 * 浏览器标签页图标：没上传 Logo 用内置 favicon.svg，
 * 上传过就把站点 Logo 当图标（带 v 参数，换图后不会被缓存住）。
 */
function applyFavicon(updatedAt: number): void {
  if (typeof document === 'undefined') return;
  const uploaded = updatedAt > 0;
  const href = uploaded ? api.siteLogoUrl(updatedAt) : withBase('/favicon.svg');
  const type = uploaded ? 'image/png' : 'image/svg+xml';
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    '#app-favicon, #app-apple-icon',
  )) {
    link.href = href;
    link.type = type;
  }
}

export async function loadSiteSettings(): Promise<void> {
  try {
    const settings = await api.getSiteSettings();
    title.value = settings.title || '设备农场';
    subtitle.value = settings.subtitle || 'Device Hub';
    logoUpdatedAt.value = settings.logoUpdatedAt;
    operatorDeviceLimit.value = settings.operatorDeviceLimit ?? 1;
    adminDeviceLimit.value = settings.adminDeviceLimit ?? 0;
    superadminDeviceLimit.value = settings.superadminDeviceLimit ?? 0;
    applyFavicon(logoUpdatedAt.value);
  } catch {
    /* 读不到就用默认值 */
  }
}

export function applySiteSettings(settings: {
  title: string;
  subtitle: string;
  logoUpdatedAt: number;
  operatorDeviceLimit?: number;
  adminDeviceLimit?: number;
  superadminDeviceLimit?: number;
}): void {
  title.value = settings.title || '设备农场';
  subtitle.value = settings.subtitle || 'Device Hub';
  logoUpdatedAt.value = settings.logoUpdatedAt;
  if (settings.operatorDeviceLimit !== undefined) {
    operatorDeviceLimit.value = settings.operatorDeviceLimit;
  }
  if (settings.adminDeviceLimit !== undefined) {
    adminDeviceLimit.value = settings.adminDeviceLimit;
  }
  if (settings.superadminDeviceLimit !== undefined) {
    superadminDeviceLimit.value = settings.superadminDeviceLimit;
  }
  applyFavicon(logoUpdatedAt.value);
}

export function setSiteLogo(updatedAt: number): void {
  logoUpdatedAt.value = updatedAt;
  applyFavicon(logoUpdatedAt.value);
}

export function useSite(): {
  title: typeof title;
  subtitle: typeof subtitle;
  logoUpdatedAt: typeof logoUpdatedAt;
  operatorDeviceLimit: typeof operatorDeviceLimit;
  adminDeviceLimit: typeof adminDeviceLimit;
  superadminDeviceLimit: typeof superadminDeviceLimit;
} {
  return {
    title,
    subtitle,
    logoUpdatedAt,
    operatorDeviceLimit,
    adminDeviceLimit,
    superadminDeviceLimit,
  };
}