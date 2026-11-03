<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NSpin,
  NTabPane,
  NTabs,
  useMessage,
} from 'naive-ui';
import LogoCropper from '../components/LogoCropper.vue';
import { api, type ServerInfo } from '../api';
import {
  applySiteSettings,
  loadSiteSettings,
  setSiteLogo,
  useSite,
} from '../stores/site';

const message = useMessage();
const {
  title,
  subtitle,
  logoUpdatedAt,
  operatorDeviceLimit: limit,
  adminDeviceLimit,
  superadminDeviceLimit,
} = useSite();

const titleInput = ref('');
const subtitleInput = ref('');
const operatorLimit = ref(1);
const adminLimit = ref(0);
const superLimit = ref(0);
const saving = ref(false);
const savingLimit = ref(false);
const uploading = ref(false);
const loading = ref(true);
const fileInput = ref<HTMLInputElement | null>(null);
const cropSrc = ref('');
const cropShow = ref(false);

const health = ref<{ version: string } | null>(null);
const serverInfo = ref<ServerInfo | null>(null);

const logoUrl = computed(() =>
  logoUpdatedAt.value > 0 ? api.siteLogoUrl(logoUpdatedAt.value) : '',
);

const storageText = computed(() => {
  const info = serverInfo.value;
  if (!info) return '—';
  return info.storage
    ? info.storage.driver === 'oss'
      ? `OSS · ${info.storage.bucket}/${info.storage.prefix}`
      : '本地文件'
    : '本地文件';
});

onMounted(async () => {
  await loadSiteSettings();
  titleInput.value = title.value;
  subtitleInput.value = subtitle.value;
  operatorLimit.value = limit?.value ?? 1;
  adminLimit.value = adminDeviceLimit?.value ?? 0;
  superLimit.value = superadminDeviceLimit?.value ?? 0;

  try {
    const [h, info] = await Promise.all([api.health(), api.serverInfo()]);
    health.value = h;
    serverInfo.value = info;
  } catch {
    /* 读不到就显示占位 */
  }
  loading.value = false;
});

async function saveSite(): Promise<void> {
  const nextTitle = titleInput.value.trim();
  if (!nextTitle) {
    message.warning('标题不能为空');
    return;
  }

  saving.value = true;
  try {
    const settings = await api.updateSiteSettings({
      title: nextTitle,
      subtitle: subtitleInput.value.trim(),
    });
    applySiteSettings(settings);
    titleInput.value = settings.title;
    subtitleInput.value = settings.subtitle;
    document.title = `${settings.title} · ${settings.subtitle}`;
    message.success('已保存');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function saveLimit(): Promise<void> {
  savingLimit.value = true;
  try {
    const settings = await api.updateSiteSettings({
      title: title.value,
      subtitle: subtitle.value,
      operatorDeviceLimit: operatorLimit.value,
      adminDeviceLimit: adminLimit.value,
      superadminDeviceLimit: superLimit.value,
    });
    applySiteSettings(settings);
    message.success('已保存，立即生效');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingLimit.value = false;
  }
}

function pickLogo(): void {
  fileInput.value?.click();
}

async function onLogoSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  cropSrc.value = URL.createObjectURL(file);
  cropShow.value = true;
}

/** 裁剪确认后上传。 */
async function onLogoCropped(blob: Blob): Promise<void> {
  uploading.value = true;
  try {
    const result = await api.uploadSiteLogo(blob);
    setSiteLogo(result.logoUpdatedAt);
    message.success('Logo 已更新');
    closeCrop();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '上传失败');
  } finally {
    uploading.value = false;
  }
}

function closeCrop(): void {
  cropShow.value = false;
  if (cropSrc.value.startsWith('blob:')) URL.revokeObjectURL(cropSrc.value);
  cropSrc.value = '';
}

async function removeLogo(): Promise<void> {
  try {
    const result = await api.removeSiteLogo();
    setSiteLogo(result.logoUpdatedAt);
    message.success('Logo 已移除');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '移除失败');
  }
}
</script>

<template>
  <div class="settings-page">
    <n-spin :show="loading">
      <n-tabs type="line" animated>
        <n-tab-pane name="site" tab="站点信息">
          <div class="panel">
            <div class="field">
              <div class="label">标题</div>
              <n-input
                v-model:value="titleInput"
                size="small"
                maxlength="40"
                show-count
                placeholder="设备农场"
                style="max-width: 320px"
              />
              <div class="hint">显示在登录页、侧边栏和浏览器标题。</div>
            </div>

            <div class="field">
              <div class="label">副标题</div>
              <n-input
                v-model:value="subtitleInput"
                size="small"
                maxlength="60"
                placeholder="Device Hub"
                style="max-width: 320px"
              />
              <div class="hint">标题下方的说明文字，例如团队或平台名称。</div>
            </div>

            <div class="field">
              <div class="label">Logo</div>
              <div class="control">
                <div class="logo-box">
                  <img v-if="logoUrl" :src="logoUrl" alt="logo" />
                  <span v-else class="logo-empty">未上传</span>
                </div>
                <n-button size="small" :loading="uploading" @click="pickLogo">
                  上传 Logo
                </n-button>
                <n-button
                  v-if="logoUrl"
                  size="small"
                  quaternary
                  type="error"
                  @click="removeLogo"
                >
                  移除
                </n-button>
              </div>
              <div class="hint">
                建议正方形图片，最大 5MB，会自动缩放成 256×256。
              </div>
            </div>

            <div class="actions">
              <n-button type="primary" size="small" :loading="saving" @click="saveSite">
                保存
              </n-button>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="control" tab="控制规则">
          <div class="panel">
            <div class="field">
              <div class="label">超级管理员同时控制设备数</div>
              <div class="control">
                <n-input-number
                  v-model:value="superLimit"
                  size="small"
                  :min="0"
                  :max="50"
                  style="width: 140px"
                />
                <span class="hint">0 表示不限制（默认）</span>
              </div>
            </div>

            <div class="field">
              <div class="label">管理员同时控制设备数</div>
              <div class="control">
                <n-input-number
                  v-model:value="adminLimit"
                  size="small"
                  :min="0"
                  :max="50"
                  style="width: 140px"
                />
                <span class="hint">0 表示不限制（默认）</span>
              </div>
            </div>

            <div class="field">
              <div class="label">普通用户同时控制设备数</div>
              <div class="control">
                <n-input-number
                  v-model:value="operatorLimit"
                  size="small"
                  :min="0"
                  :max="50"
                  style="width: 140px"
                />
                <span class="hint">0 表示不限制，默认 1 台</span>
              </div>
              <div class="hint">
                超过上限时创建投屏会被拒绝，保存后立即生效。
              </div>
            </div>

            <div class="actions">
              <n-button
                type="primary"
                size="small"
                :loading="savingLimit"
                @click="saveLimit"
              >
                保存
              </n-button>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="system" tab="系统信息">
          <div class="panel">
            <div class="field">
              <div class="label">服务版本</div>
              <div class="value">{{ health?.version ?? '—' }}</div>
            </div>
            <div class="field">
              <div class="label">监听端口</div>
              <div class="value">{{ serverInfo?.port ?? '—' }}</div>
            </div>
            <div class="field">
              <div class="label">文件存储</div>
              <div class="value">{{ storageText }}</div>
            </div>
          </div>
        </n-tab-pane>
      </n-tabs>

      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        hidden
        @change="onLogoSelected"
      />

      <n-modal
        :show="cropShow"
        preset="card"
        title="裁剪 Logo"
        style="width: 380px"
        :bordered="false"
        @update:show="closeCrop"
      >
        <LogoCropper
          v-if="cropSrc"
          :src="cropSrc"
          @confirm="onLogoCropped"
          @cancel="closeCrop"
        />
      </n-modal>
    </n-spin>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 760px;
}

.panel {
  padding: 8px 2px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}

.field:last-of-type {
  border-bottom: none;
}

.label {
  font-size: 12px;
  color: var(--text-dim);
}

.control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
}

.value {
  font-size: 13px;
  color: var(--text);
}

.actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

.logo-box {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  overflow: hidden;
}

.logo-box img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.logo-empty {
  font-size: 10px;
  color: var(--text-faint);
}
</style>