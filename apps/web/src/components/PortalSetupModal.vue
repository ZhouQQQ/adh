<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NIcon, NModal, NSpin, useMessage } from 'naive-ui';
import {
  CheckmarkCircleOutline,
  CopyOutline,
  DownloadOutline,
  PhonePortraitOutline,
} from '@vicons/ionicons5';
import QRCode from 'qrcode';
import { api, type PortalInfo } from '../api';
import { withBase } from '../base';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const loading = ref(false);
const info = ref<PortalInfo | null>(null);
const error = ref('');
const qr = ref('');

/**
 * 与 App 内「授权状态」列表保持一致：
 * apps/portal-android/.../MainActivity.kt → permissionCard()
 * 顺序和数量都不要单独改，改 App 时同步这里。
 */
const PERMISSIONS = [
  '屏幕录制',
  '无障碍服务',
  '默认输入法',
  '设备管理员',
  '所有文件访问',
  '安装未知应用',
  '修改系统设置',
  '通知权限',
  '位置信息',
  '忽略电池优化',
  '自启动 / 后台运行',
];

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const showModal = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
});

const address = computed(() => {
  const raw = info.value?.address ?? '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (isLoopbackHost(url.hostname)) {
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (isLoopbackHost(window.location.hostname)) {
        url.hostname = info.value?.lanIp ?? window.location.hostname;
        url.port = info.value?.port ? String(info.value.port) : '';
      } else {
        url.hostname = window.location.hostname;
        url.port = window.location.port;
      }
    }
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return raw;
  }
});

const publicOrigin = computed(() => {
  if (isLoopbackHost(window.location.hostname) && info.value?.lanIp) {
    return `${window.location.protocol}//${info.value.lanIp}:${info.value.port}`;
  }
  return window.location.origin;
});

const downloadUrl = computed(() => {
  if (!info.value) return '';
  const token = localStorage.getItem('adh.token') ?? '';
  return `${publicOrigin.value}${withBase(info.value.android.url)}?token=${encodeURIComponent(token)}`;
});

watch(
  downloadUrl,
  async (url) => {
    if (!url) {
      qr.value = '';
      return;
    }
    try {
      qr.value = await QRCode.toDataURL(url, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#18181b', light: '#ffffff' },
      });
    } catch {
      qr.value = '';
    }
  },
  { immediate: true },
);

/** 连接地址二维码：App 里点「扫一扫」即可自动填入并连接。 */
const connectQr = ref('');

watch(
  address,
  async (value) => {
    if (!value) {
      connectQr.value = '';
      return;
    }
    try {
      connectQr.value = await QRCode.toDataURL(value, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#18181b', light: '#ffffff' },
      });
    } catch {
      connectQr.value = '';
    }
  },
  { immediate: true },
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    info.value = await api.portalInfo();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取直连配置失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.show,
  (visible) => {
    if (visible && !info.value) void load();
  },
);

function downloadAndroid(): void {
  if (!downloadUrl.value) return;
  window.open(downloadUrl.value, '_blank', 'noopener');
}

async function copyAddress(): Promise<void> {
  const value = address.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    message.success('连接地址已复制');
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(input);
    if (copied) message.success('连接地址已复制');
    else message.warning('当前浏览器不允许写剪贴板，请手动复制');
  }
}
</script>

<template>
  <n-modal
    v-model:show="showModal"
    preset="card"
    title="设备无线直连"
    style="width: 520px; max-width: calc(100vw - 32px)"
    :bordered="false"
  >
    <n-spin :show="loading">
      <div v-if="error" class="error">{{ error }}</div>

      <div v-else-if="info" class="portal-body">
        <section class="step">
          <span class="step-no">1</span>
          <div class="step-main">
            <strong>下载安装</strong>
            <div class="download-row">
              <div class="download-left">
                <div class="platform">
                  <n-icon :size="24"><PhonePortraitOutline /></n-icon>
                  <div>
                    <strong>Android</strong>
                    <span>v{{ info.android.version }} · 8.0+ · 1.9 MB</span>
                  </div>
                </div>
                <n-button type="primary" size="small" @click="downloadAndroid">
                  <template #icon>
                    <n-icon><DownloadOutline /></n-icon>
                  </template>
                  下载 APK
                </n-button>
              </div>
              <div class="qr-wrap">
                <img v-if="qr" :src="qr" alt="扫码下载 APK" />
                <span>扫码下载</span>
              </div>
            </div>
            <p class="install-tip">
              安装被系统拦截？<strong>vivo / iQOO</strong> 到「应用信息 → 右上角 ⋮ → 解除限制」；
              <strong>小米 / Redmi</strong> 关闭「安全模式」；<strong>华为 / 荣耀</strong> 关闭「纯净模式」；
              <strong>OPPO / 一加 / realme</strong> 关闭「安全检测」。装好后在 App 授权状态里开启「安装未知应用」。
            </p>
          </div>
        </section>

        <section class="step">
          <span class="step-no">2</span>
          <div class="step-main">
            <strong>开启权限</strong>
            <ul class="checks">
              <li v-for="item in PERMISSIONS" :key="item">
                <n-icon color="#16a34a" :size="14"><CheckmarkCircleOutline /></n-icon>
                {{ item }}
              </li>
            </ul>
            <span class="step-note">在 App 的「设置」里逐项开启；投屏授权时必须选择「共享整个屏幕」，否则控制台会黑屏。</span>
          </div>
        </section>

        <section class="step">
          <span class="step-no">3</span>
          <div class="step-main">
            <strong>启动连接</strong>
            <div class="connect-row">
              <div class="connect-left">
                <div class="address-block">
                  <div class="address-head">
                    <span>连接地址</span>
                    <n-button size="tiny" quaternary @click="copyAddress">
                      <template #icon>
                        <n-icon><CopyOutline /></n-icon>
                      </template>
                      复制
                    </n-button>
                  </div>
                  <code>{{ address }}</code>
                </div>
                <span class="step-note">
                  方式一：在 App 里粘贴地址，点「连接」。<br />
                  方式二：点 App 里的「扫一扫」，扫描右侧二维码自动填入并连接。<br />
                  地址里的 key 就是你自己的 API Key：连上后在「设备管理」里全平台统一管理，
                  并记录这台手机是谁连的。
                </span>
              </div>
              <div class="qr-wrap connect-qr">
                <img v-if="connectQr" :src="connectQr" alt="扫码连接" />
                <span>扫码连接</span>
              </div>
            </div>
          </div>
        </section>

        <p class="ios-note">{{ info.ios.note }}</p>
      </div>
    </n-spin>
  </n-modal>
</template>

<style scoped>
.portal-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.error {
  padding: 10px 12px;
  border-radius: 8px;
  background: #fee2e2;
  color: #dc2626;
  font-size: 13px;
}

.step {
  display: flex;
  gap: 10px;
}

.step-no {
  flex: none;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #18181b;
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
}

.step-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-main > strong {
  font-size: 13px;
  color: #09090b;
}

.download-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
}

.download-left {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.platform {
  display: flex;
  align-items: center;
  gap: 8px;
}

.platform div {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.platform strong {
  font-size: 13px;
  color: #09090b;
}

.platform span {
  font-size: 11px;
  color: #71717a;
}

.qr-wrap {
  flex: none;
  width: 92px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.qr-wrap img {
  width: 88px;
  height: 88px;
  display: block;
  border-radius: 6px;
}

.qr-wrap span {
  font-size: 10px;
  color: #a1a1aa;
}

.install-tip {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: #71717a;
}

.install-tip strong {
  color: #3f3f46;
  font-weight: 600;
}

.checks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.checks li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #3f3f46;
}

.address-block {
  padding: 10px 12px;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  background: #fafafa;
}

.connect-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.connect-left {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.connect-qr {
  padding-top: 2px;
}

.address-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 12px;
  color: #71717a;
}

.address-block code {
  display: block;
  font-size: 12px;
  color: #18181b;
  word-break: break-all;
  line-height: 1.5;
}

.step-note {
  font-size: 12px;
  color: #71717a;
  line-height: 1.6;
}

.ios-note {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fafafa;
  font-size: 11px;
  color: #71717a;
  line-height: 1.6;
}
</style>
