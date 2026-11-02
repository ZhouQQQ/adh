<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NModal,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import { api, type PackageRecord } from '../api';

const props = defineProps<{
  show: boolean;
  deviceId: string;
  deviceName: string;
  platform: string;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  installed: [];
}>();

const message = useMessage();

const tab = ref<'local' | 'server'>('local');
const fileInput = ref<HTMLInputElement | null>(null);
const localFile = ref<File | null>(null);
const packages = ref<PackageRecord[]>([]);
const keyword = ref('');
const selectedId = ref<string | null>(null);
const loading = ref(false);
const busy = ref(false);
const step = ref('');

const canInstall = computed(() => props.platform === 'android');

const installable = computed(() =>
  packages.value.filter((item) => item.kind === 'apk'),
);

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return installable.value;
  return installable.value.filter((item) =>
    item.name.toLowerCase().includes(text),
  );
});

const selected = computed(
  () => installable.value.find((item) => item.id === selectedId.value) ?? null,
);

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    localFile.value = null;
    selectedId.value = null;
    keyword.value = '';
    step.value = '';
    void loadPackages();
  },
);

function formatSize(size: number): string {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function loadPackages(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.listPackages();
    packages.value = result.packages;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取安装包失败');
  } finally {
    loading.value = false;
  }
}

function pickFile(): void {
  fileInput.value?.click();
}

function onFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.apk')) {
    message.error('请选择 .apk 文件');
    return;
  }
  localFile.value = file;
}

async function install(packageId: string, label: string): Promise<void> {
  busy.value = true;
  step.value = `正在安装 ${label} …`;
  try {
    await api.installPackage(props.deviceId, packageId);
    message.success(`已安装 ${label}`);
    emit('installed');
    emit('update:show', false);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '安装失败');
  } finally {
    busy.value = false;
    step.value = '';
  }
}

async function installLocal(): Promise<void> {
  const file = localFile.value;
  if (!file) {
    message.warning('请先选择 APK 文件');
    return;
  }

  busy.value = true;
  step.value = `正在上传 ${file.name} …`;
  try {
    const uploaded = await api.uploadPackage(file);
    step.value = `正在安装 ${file.name} …`;
    await api.installPackage(props.deviceId, uploaded.id);
    message.success(`已安装 ${file.name}`);
    emit('installed');
    emit('update:show', false);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '安装失败');
  } finally {
    busy.value = false;
    step.value = '';
  }
}

function installSelected(): void {
  if (!selected.value) {
    message.warning('请选择要安装的安装包');
    return;
  }
  void install(selected.value.id, selected.value.name);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="`安装应用到 ${deviceName}`"
    style="width: 520px"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="!canInstall" class="notice">
      当前设备不是 Android，暂不支持安装 APK。
    </div>

    <template v-else>
      <n-tabs v-model:value="tab" type="line" animated size="small">
        <n-tab-pane name="local" tab="本地文件">
          <div class="local">
            <input
              ref="fileInput"
              type="file"
              accept=".apk"
              hidden
              @change="onFileSelected"
            />
            <n-button size="small" :disabled="busy" @click="pickFile">
              选择 APK
            </n-button>
            <span v-if="localFile" class="file-name" :title="localFile.name">
              {{ localFile.name }} · {{ formatSize(localFile.size) }}
            </span>
            <span v-else class="file-hint">未选择文件</span>
            <n-button
              size="small"
              type="primary"
              class="install-btn"
              :loading="busy"
              :disabled="!localFile"
              @click="installLocal"
            >
              上传并安装
            </n-button>
          </div>
          <p class="tip">本地文件会先保存到应用管理，再推送到设备。</p>
        </n-tab-pane>

        <n-tab-pane name="server" tab="已上传">
          <n-input
            v-model:value="keyword"
            size="small"
            clearable
            placeholder="搜索文件名"
          />

          <n-spin :show="loading">
            <div class="list">
              <n-empty
                v-if="filtered.length === 0 && !loading"
                description="没有可安装的 APK"
                class="empty"
              />
              <button
                v-for="item in filtered"
                :key="item.id"
                type="button"
                class="row"
                :class="{ active: selectedId === item.id }"
                @click="selectedId = item.id"
              >
                <span class="row-name" :title="item.name">{{ item.name }}</span>
                <span class="row-size">{{ formatSize(item.size) }}</span>
                <n-tag v-if="selectedId === item.id" size="tiny" :bordered="false">
                  已选
                </n-tag>
              </button>
            </div>
          </n-spin>

          <div class="server-foot">
            <span class="tip">IPA 只能留存，无法安装到 Android。</span>
            <n-button
              size="small"
              type="primary"
              :loading="busy"
              :disabled="!selected"
              @click="installSelected"
            >
              安装
            </n-button>
          </div>
        </n-tab-pane>
      </n-tabs>

      <div v-if="step" class="step">{{ step }}</div>
    </template>
  </n-modal>
</template>

<style scoped>
.notice {
  padding: 12px;
  border-radius: 6px;
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-dim);
}

.local {
  display: flex;
  align-items: center;
  gap: 10px;
}

.file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-hint {
  flex: 1;
  font-size: 12px;
  color: var(--text-faint);
}

.install-btn {
  flex: none;
}

.tip {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}

.list {
  margin-top: 10px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--surface-2);
}

.row.active {
  background: var(--surface-2);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  padding: 32px 0;
}

.server-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.server-foot .tip {
  margin: 0;
  flex: 1;
}

.step {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-dim);
}
</style>