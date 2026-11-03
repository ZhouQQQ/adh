import { ref } from 'vue';
import { api } from '../api';

/** 站点标题、副标题与 Logo，登录页和侧边栏共用。 */
const title = ref('设备农场');
const subtitle = ref('Device Hub');
const logoUpdatedAt = ref(0);
/** 普通用户可同时控制的设备数，0 表示不限。 */
const operatorDeviceLimit = ref(1);
/** 管理员可同时控制的设备数，0 表示不限。 */
const adminDeviceLimit = ref(0);

export async function loadSiteSettings(): Promise<void> {
  try {
    const settings = await api.getSiteSettings();
    title.value = settings.title || '设备农场';
    subtitle.value = settings.subtitle || 'Device Hub';
    logoUpdatedAt.value = settings.logoUpdatedAt;
    operatorDeviceLimit.value = settings.operatorDeviceLimit ?? 1;
    adminDeviceLimit.value = settings.adminDeviceLimit ?? 0;
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
}

export function setSiteLogo(updatedAt: number): void {
  logoUpdatedAt.value = updatedAt;
}

export function useSite(): {
  title: typeof title;
  subtitle: typeof subtitle;
  logoUpdatedAt: typeof logoUpdatedAt;
  operatorDeviceLimit: typeof operatorDeviceLimit;
  adminDeviceLimit: typeof adminDeviceLimit;
} {
  return {
    title,
    subtitle,
    logoUpdatedAt,
    operatorDeviceLimit,
    adminDeviceLimit,
  };
}