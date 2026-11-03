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
import { api, type PackageKind, type PackageRecord } from '../api';

interface DeviceRef {
  id: string;
  name: string;
  platform: 'android' | 'ios';
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
const totalTargets = ref(0);
const results = ref<InstallResult[]>([]);

const androidCount = computed(
  () => props.devices.filter((item) => item.platform === 'android').length,
);
const iosCount = computed(
  () => props.devices.filter((item) => item.platform === 'ios').length,
);

const localKind = computed<PackageKind | null>(() => {
  const name = localFile.value?.name.toLowerCase() ?? '';
  if (!name) return null;
  return name.endsWith('.ipa') ? 'ipa' : 'apk';
});

const localTargetCount = computed(() =>
  localKind.value ? targetCount(localKind.value) : 0,
);

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return packages.value;
  return packages.value.filter((item) =>
    item.name.toLowerCase().includes(text),
  );
});

const selected = computed(
  () => packages.value.find((item) => item.id === selectedId.value) ?? null,
);

const selectedTargetCount = computed(() =>
  selected.value ? targetCount(selected.value.kind) : 0,
);

const succeeded = computed(() => results.value.filter((item) => item.ok).length);

function targetCount(kind: PackageKind): number {
  return kind === 'ipa' ? iosCount.value : androidCount.value;
}

function targetHint(kind: PackageKind): string {
  const count = targetCount(kind);
  const label = kind === 'ipa' ? 'iOS' : 'Android';
  return count > 0
    ? `只会安装到 ${count} 台 ${label} 设备`
    : `没有可安装的 ${label} 设备`;
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    localFile.value = null;
    selectedId.value = null;
    keyword.value = '';
    results.value = [];
    progress.value = 0;
    totalTargets.value = 0;
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

/** 只对与安装包类型匹配的设备安装：APK → Android，IPA → iOS。 */
async function installToAll(
  packageId: string,
  label: string,
  kind: PackageKind,
): Promise<void> {
  const targets = props.devices.filter((device) =>
    kind === 'ipa' ? device.platform === 'ios' : device.platform === 'android',
  );
  if (targets.length === 0) {
    message.warning(targetHint(kind));
    return;
  }

  installing.value = true;
  results.value = [];
  progress.value = 0;
  totalTargets.value = targets.length;
  step.value = `正在安装 ${label}`;

  for (const device of targets) {
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
  if (succeeded.value === targets.length) {
    message.success(`已在 ${targets.length} 台设备上安装 ${label}`);
  } else {
    message.warning(`安装完成：成功 ${succeeded.value} / ${targets.length}`);
  }
  emit('installed');
}

async function installLocal(): Promise<void> {
  const file = localFile.value;
  const kind = localKind.value;
  if (!file || !kind) {
    message.warning('请先选择安装包');
    return;
  }

  installing.value = true;
  step.value = `正在上传 ${file.name}`;
  progress.value = 0;
  try {
    const uploaded = await api.uploadPackage(file);
    if (targetCount(uploaded.kind) === 0) {
      installing.value = false;
      step.value = '';
      message.warning(
        `${file.name} 已保存到应用管理，但没有可安装的 ${
          uploaded.kind === 'ipa' ? 'iOS' : 'Android'
        } 设备`,
      );
      return;
    }
    await installToAll(uploaded.id, file.name, uploaded.kind);
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
  void installToAll(selected.value.id, selected.value.name, selected.value.kind);
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
            :disabled="!localFile || localTargetCount === 0 || installing"
            @click="installLocal"
          >
            安装到 {{ localTargetCount }} 台
          </n-button>
        </div>
        <p
          v-if="localKind"
          class="tip"
          :class="{ warn: localTargetCount === 0 }"
        >
          {{ localKind.toUpperCase() }} · {{ targetHint(localKind) }}
        </p>
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
              description="暂无安装包"
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
              <n-tag size="tiny" :bordered="false">
                {{ item.kind.toUpperCase() }}
              </n-tag>
              <span class="row-name" :title="item.name">{{ item.name }}</span>
              <span class="row-size">{{ formatSize(item.size) }}</span>
              <n-tag v-if="selectedId === item.id" size="tiny" :bordered="false">
                已选
              </n-tag>
            </button>
          </div>
        </n-spin>

        <div class="server-foot">
          <span
            class="tip"
            :class="{ warn: selected && selectedTargetCount === 0 }"
          >
            {{ selected ? targetHint(selected.kind) : '选择安装包后按类型安装' }}
          </span>
          <n-button
            size="small"
            type="primary"
            :loading="installing && tab === 'server'"
            :disabled="!selected || selectedTargetCount === 0 || installing"
            @click="installSelected"
          >
            安装到 {{ selectedTargetCount }} 台
          </n-button>
        </div>
      </n-tab-pane>
    </n-tabs>

    <div v-if="step" class="step">
      <span>{{ step }} （{{ progress }} / {{ totalTargets }}）</span>
      <n-progress
        type="line"
        :percentage="totalTargets ? Math.round((progress / totalTargets) * 100) : 0"
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

.tip.warn {
  color: #d97706;
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