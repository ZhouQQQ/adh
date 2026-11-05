<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NSpin,
  NSwitch,
  NTabPane,
  NTabs,
  useMessage,
} from 'naive-ui';
import LogoCropper from '../components/LogoCropper.vue';
import { api, type ServerInfo, type ApiKeyRecord } from '../api';
import { BASE_PATH } from '../base';
import {
  cacheApiKey,
  readCachedApiKey,
} from '../api-key-cache';
import { useAuth } from '../stores/auth';
import {
  applySiteSettings,
  loadSiteSettings,
  setSiteLogo,
  useSite,
} from '../stores/site';

const message = useMessage();
const { isSuper, user, loadMe } = useAuth();
const {
  title,
  subtitle,
  logoUpdatedAt,
  operatorDeviceLimit: limit,
  adminDeviceLimit,
  superadminDeviceLimit,
  idleTimeoutMinutes,
} = useSite();

const titleInput = ref('');
const subtitleInput = ref('');
const operatorLimit = ref(1);
const adminLimit = ref(0);
const superLimit = ref(0);
const idleLimit = ref(5);
const saving = ref(false);
const savingLimit = ref(false);
const uploading = ref(false);
const loading = ref(true);
const fileInput = ref<HTMLInputElement | null>(null);
const cropSrc = ref('');
const cropShow = ref(false);

const health = ref<{ version: string } | null>(null);
const serverInfo = ref<ServerInfo | null>(null);

const aiEnabled = ref(false);
const aiBaseUrl = ref('https://api.openai.com/v1');
const aiModel = ref('');
const aiApiKey = ref('');
const aiHasKey = ref(false);
const aiKeyHint = ref('');
const aiSaving = ref(false);

const apiKeyList = ref<ApiKeyRecord[]>([]);
const newApiKey = ref('');
const apiKeyCreating = ref(false);
const mcpExampleUrl = computed(
  () => `${window.location.origin}${BASE_PATH}/mcp?key=${newApiKey.value || 'adhk_xxx'}`,
);

function formatTime(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadApiKeys(): Promise<void> {
  try {
    if (!user.value) await loadMe();
    const data = await api.listApiKeys();
    apiKeyList.value = data.keys;
    if (data.key) {
      // 首次进入自动生成，明文只返回一次，缓存到当前浏览器
      newApiKey.value = data.key;
      cacheApiKey(user.value?.id, data.key);
    } else if (!newApiKey.value) {
      newApiKey.value = readCachedApiKey(user.value?.id);
    }
  } catch {
    /* 非超级管理员或读取失败时保持空 */
  }
}

async function resetApiKey(): Promise<void> {
  if (apiKeyCreating.value) return;
  apiKeyCreating.value = true;
  try {
    const result = await api.resetApiKey();
    newApiKey.value = result.key;
    cacheApiKey(user.value?.id, result.key);
    await loadApiKeys();
    message.success('已重置 API Key');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重置失败');
  } finally {
    apiKeyCreating.value = false;
  }
}

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
  idleLimit.value = idleTimeoutMinutes?.value ?? 5;

  try {
    const [h, info] = await Promise.all([api.health(), api.serverInfo()]);
    health.value = h;
    serverInfo.value = info;
  } catch {
    /* 读不到就显示占位 */
  }
  loading.value = false;
});

/** 用户信息可能晚于页面挂载加载，登录状态变化时再拉一次 AI 配置。 */
async function loadAi(): Promise<void> {
  try {
    const ai = await api.getAiSettings();
    aiEnabled.value = ai.enabled;
    aiBaseUrl.value = ai.baseUrl;
    aiModel.value = ai.model;
    aiHasKey.value = ai.hasApiKey;
    aiKeyHint.value = ai.apiKey;
  } catch {
    /* 非超级管理员或未配置时保持默认值 */
  }
}

watch(
  isSuper,
  (value) => {
    if (value) {
      void loadAi();
      void loadApiKeys();
    }
  },
  { immediate: true },
);

async function saveAi(): Promise<void> {
  aiSaving.value = true;
  try {
    const input: {
      enabled: boolean;
      baseUrl: string;
      model: string;
      apiKey?: string;
    } = {
      enabled: aiEnabled.value,
      baseUrl: aiBaseUrl.value.trim(),
      model: aiModel.value.trim(),
    };
    // 留空表示不修改已有 key
    if (aiApiKey.value.trim()) input.apiKey = aiApiKey.value.trim();

    const saved = await api.updateAiSettings(input);
    aiEnabled.value = saved.enabled;
    aiBaseUrl.value = saved.baseUrl;
    aiModel.value = saved.model;
    aiHasKey.value = saved.hasApiKey;
    aiKeyHint.value = saved.apiKey;
    aiApiKey.value = '';
    message.success('AI 配置已保存');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    aiSaving.value = false;
  }
}

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
      idleTimeoutMinutes: idleLimit.value,
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
                <span class="hint">0 表示不限制，默认 2 台</span>
              </div>
              <div class="hint">
                超过上限时创建投屏会被拒绝，保存后立即生效。
              </div>
            </div>

            <div class="field">
              <div class="label">无操作自动断开</div>
              <div class="control">
                <n-input-number
                  v-model:value="idleLimit"
                  size="small"
                  :min="0"
                  :max="120"
                  :precision="0"
                  style="width: 140px"
                />
                <span class="hint">分钟</span>
              </div>
              <div class="hint">
                控制端超过该时长没有操作会自动结束投屏，默认 5 分钟；0
                表示不自动断开。
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

        <n-tab-pane v-if="isSuper" name="ai" tab="AI 助手">
          <div class="panel">
            <div class="field">
              <div class="label">启用 AI 助手</div>
              <div class="control">
                <n-switch v-model:value="aiEnabled" size="small" />
                <span class="hint">
                  开启后，设备控制者可以在控制页用自然语言操作设备。
                </span>
              </div>
            </div>

            <div class="field">
              <div class="label">模型服务地址</div>
              <n-input
                v-model:value="aiBaseUrl"
                size="small"
                placeholder="https://api.openai.com/v1"
                style="max-width: 420px"
              />
              <div class="hint">
                OpenAI 兼容接口，填到 /v1 为止，例如 https://api.deepseek.com/v1。
              </div>
            </div>

            <div class="field">
              <div class="label">API Key</div>
              <n-input
                v-model:value="aiApiKey"
                type="password"
                show-password-on="click"
                size="small"
                :placeholder="
                  aiHasKey ? `已配置（${aiKeyHint}），留空不修改` : 'sk-...'
                "
                style="max-width: 420px"
              />
              <div class="hint">
                只保存在服务端，不会下发给 agent 或浏览器。
              </div>
            </div>

            <div class="field">
              <div class="label">模型名称</div>
              <n-input
                v-model:value="aiModel"
                size="small"
                placeholder="gpt-4o / qwen-vl-max / glm-4v"
                style="max-width: 320px"
              />
              <div class="hint">
                必须支持视觉输入（vision），否则无法识别屏幕内容。
              </div>
            </div>

            <div class="actions">
              <n-button
                type="primary"
                size="small"
                :loading="aiSaving"
                @click="saveAi"
              >
                保存
              </n-button>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane v-if="isSuper" name="api" tab="API / MCP">
          <div class="panel">
            <div class="field">
              <div class="label">API Key（自动生成）</div>
              <div class="control">
                <n-button
                  type="primary"
                  size="small"
                  :loading="apiKeyCreating"
                  @click="resetApiKey"
                >
                  重置 Key
                </n-button>
              </div>
              <div class="hint">
                系统已为每位用户维护一把默认 Key，无需手动创建。
                需要更换时点「重置 Key」，旧 Key 会立即失效。
              </div>
            </div>

            <div v-if="newApiKey" class="api-key-reveal">
              <div class="label">当前 Key（已保存在本浏览器）</div>
              <pre>{{ newApiKey }}</pre>
            </div>

            <div class="field">
              <div class="label">已有 Key</div>
              <div v-if="!apiKeyList.length" class="hint">还没有 API Key。</div>
              <div
                v-for="key in apiKeyList"
                :key="key.id"
                class="api-key-row"
              >
                <div class="api-key-meta">
                  <strong>{{ key.name }}</strong>
                  <span>
                    {{ key.prefix }}… · 创建 {{ formatTime(key.createdAt) }}
                    <template v-if="key.lastUsedAt">
                      · 最近使用 {{ formatTime(key.lastUsedAt) }}
                    </template>
                  </span>
                </div>
              </div>
            </div>

            <div class="field">
              <div class="label">MCP 配置示例</div>
              <pre class="mcp-example">{
  "mcpServers": {
    "adh": {
      "url": "{{ mcpExampleUrl }}"
    }
  }
}</pre>
              <div class="hint">
                服务端已内置 Streamable HTTP MCP，客户端只需要一个
                <code>url</code>，把 <code>adhk_xxx</code> 换成生成的 Key
                即可。域名取自当前浏览器地址；给其他机器使用时，请用局域网 IP
                或域名打开本页后再复制。工具：<code>list_devices</code>、
                <code>run_task</code>、<code>get_task</code>、
                <code>list_tasks</code>、<code>cancel_task</code>。
              </div>
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

.api-key-reveal {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}

.api-key-reveal pre,
.mcp-example {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
}

.api-key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.api-key-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.api-key-meta strong {
  font-size: 12px;
  font-weight: 600;
}

.api-key-meta span {
  font-size: 11px;
  color: var(--text-faint);
  word-break: break-all;
}
</style>