<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NModal,
  NProgress,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import { api, type PackageRecord } from '../api';

interface DeviceRef {
  id: string;
  name: string;
}

interface InstallResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

const props = defineProps<{
  show: boolean;
  devices: DeviceRef[];
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
const installing = ref(false);
const step = ref('');
const progress = ref(0);
const results = ref<InstallResult[]>([]);

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

const succeeded = computed(() => results.value.filter((item) => item.ok).length);

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    localFile.value = null;
    selectedId.value = null;
    keyword.value = '';
    results.value = [];
    progress.value = 0;
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
  if (!/\.(apk|ipa)$/i.test(file.name)) {
    message.error('只支持 .apk 或 .ipa 文件');
    return;
  }
  localFile.value = file;
}

async function installToAll(packageId: string, label: string): Promise<void> {
  installing.value = true;
  results.value = [];
  progress.value = 0;
  step.value = `正在安装 ${label}`;

  for (const device of props.devices) {
    try {
      await api.installPackage(device.id, packageId);
      results.value = [...results.value, { id: device.id, name: device.name, ok: true }];
    } catch (error) {
      results.value = [
        ...results.value,
        {
          id: device.id,
          name: device.name,
          ok: false,
          error: error instanceof Error ? error.message : '安装失败',
        },
      ];
    }
    progress.value += 1;
  }

  installing.value = false;
  step.value = '';
  const total = props.devices.length;
  if (succeeded.value === total) {
    message.success(`已在 ${total} 台设备上安装 ${label}`);
  } else {
    message.warning(`安装完成：成功 ${succeeded.value} / ${total}`);
  }
  emit('installed');
}

async function installLocal(): Promise<void> {
  const file = localFile.value;
  if (!file) {
    message.warning('请先选择安装包');
    return;
  }

  installing.value = true;
  step.value = `正在上传 ${file.name}`;
  progress.value = 0;
  try {
    const uploaded = await api.uploadPackage(file);
    if (uploaded.kind === 'ipa') {
      installing.value = false;
      step.value = '';
      message.warning(`${file.name} 已保存到应用管理，IPA 无法安装到 Android`);
      return;
    }
    await installToAll(uploaded.id, file.name);
  } catch (error) {
    installing.value = false;
    step.value = '';
    message.error(error instanceof Error ? error.message : '上传失败');
  }
}

function installSelected(): void {
  if (!selected.value) {
    message.warning('请选择要安装的安装包');
    return;
  }
  void installToAll(selected.value.id, selected.value.name);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="`批量安装 · ${devices.length} 台设备`"
    style="width: 560px"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <n-tabs v-model:value="tab" type="line" animated size="small">
      <n-tab-pane name="local" tab="本地文件">
        <div class="local">
          <input
            ref="fileInput"
            type="file"
            accept=".apk,.ipa"
            hidden
            @change="onFileSelected"
          />
          <n-button size="small" :disabled="installing" @click="pickFile">
            上传安装包
          </n-button>
          <span v-if="localFile" class="file-name" :title="localFile.name">
            {{ localFile.name }} · {{ formatSize(localFile.size) }}
          </span>
          <span v-else class="file-hint">未选择文件</span>
          <n-button
            size="small"
            type="primary"
            :loading="installing && tab === 'local'"
            :disabled="!localFile || installing"
            @click="installLocal"
          >
            安装到全部
          </n-button>
        </div>
        <p class="tip">本地文件会先保存到应用管理；IPA 仅留存，不能安装到 Android。</p>
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
          <span class="tip">{{ devices.length }} 台设备将依次安装</span>
          <n-button
            size="small"
            type="primary"
            :loading="installing && tab === 'server'"
            :disabled="!selected || installing"
            @click="installSelected"
          >
            安装到全部
          </n-button>
        </div>
      </n-tab-pane>
    </n-tabs>

    <div v-if="step" class="step">
      <span>{{ step }} （{{ progress }} / {{ devices.length }}）</span>
      <n-progress
        type="line"
        :percentage="devices.length ? Math.round((progress / devices.length) * 100) : 0"
        :show-indicator="false"
        :height="4"
      />
    </div>

    <div v-if="results.length > 0" class="results">
      <div class="results-title">
        结果：成功 {{ succeeded }} / {{ results.length }}
      </div>
      <div v-for="item in results" :key="item.id" class="result-row">
        <span class="result-name" :title="item.name">{{ item.name }}</span>
        <n-tag v-if="item.ok" size="tiny" type="success" :bordered="false">成功</n-tag>
        <n-tag v-else size="tiny" type="error" :bordered="false" :title="item.error">
          失败
        </n-tag>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
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

.tip {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}

.list {
  margin-top: 10px;
  max-height: 220px;
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

.row:hover,
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
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  font-size: 11px;
  color: var(--text-dim);
}

.results {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
  max-height: 160px;
  overflow-y: auto;
}

.results-title {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 6px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
}

.result-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>