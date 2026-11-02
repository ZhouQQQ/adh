<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NModal,
  NSpin,
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

const fileInput = ref<HTMLInputElement | null>(null);
const localFile = ref<File | null>(null);
const packages = ref<PackageRecord[]>([]);
const keyword = ref('');
const loading = ref(false);
const busy = ref(false);
const busyId = ref<string | null>(null);
const step = ref('');

const supported = computed(
  () => props.platform === 'android' || props.platform === 'ios',
);
const fileKind = computed(() => (props.platform === 'ios' ? 'ipa' : 'apk'));
const accept = computed(() => `.${fileKind.value}`);

const installable = computed(() =>
  packages.value.filter((item) => item.kind === fileKind.value),
);

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return installable.value;
  return installable.value.filter((item) =>
    item.name.toLowerCase().includes(text),
  );
});

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    localFile.value = null;
    keyword.value = '';
    step.value = '';
    busyId.value = null;
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
  if (!file.name.toLowerCase().endsWith(`.${fileKind.value}`)) {
    message.error(`请选择 .${fileKind.value} 文件`);
    return;
  }
  localFile.value = file;
}

async function install(packageId: string, label: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  busyId.value = packageId;
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
    busyId.value = null;
    step.value = '';
  }
}

async function installLocal(): Promise<void> {
  const file = localFile.value;
  if (!file) {
    message.warning('请先选择安装包');
    return;
  }

  busy.value = true;
  step.value = `正在上传 ${file.name} …`;
  try {
    const uploaded = await api.uploadPackage(file);
    if (uploaded.kind !== fileKind.value) {
      message.warning(`已保存到应用管理，但该设备只能安装 .${fileKind.value}`);
      return;
    }
    busyId.value = uploaded.id;
    step.value = `正在安装 ${file.name} …`;
    await api.installPackage(props.deviceId, uploaded.id);
    message.success(`已安装 ${file.name}`);
    emit('installed');
    emit('update:show', false);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '安装失败');
  } finally {
    busy.value = false;
    busyId.value = null;
    step.value = '';
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="`安装应用到 ${deviceName}`"
    style="width: 560px"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="!supported" class="notice">
      当前设备暂不支持安装应用。
    </div>

    <template v-else>
      <section class="block">
        <div class="block-title">本地文件</div>
        <div class="local">
          <input
            ref="fileInput"
            type="file"
            :accept="accept"
            hidden
            @change="onFileSelected"
          />
          <n-button size="small" :disabled="busy" @click="pickFile">
            上传安装包
          </n-button>
          <span v-if="localFile" class="file-name" :title="localFile.name">
            {{ localFile.name }} · {{ formatSize(localFile.size) }}
          </span>
          <span v-else class="file-hint">未选择文件</span>
          <n-button
            size="small"
            type="primary"
            :loading="busy && busyId === null"
            :disabled="!localFile || busy"
            @click="installLocal"
          >
            上传并安装
          </n-button>
        </div>
        <p class="tip">
          {{
            fileKind === 'ipa'
              ? 'IPA 会先保存到应用管理，需要有效签名才能安装到 iOS'
              : 'APK 会先保存到应用管理，再推送到设备'
          }}
        </p>
      </section>

      <section class="block">
        <div class="block-title">已上传的安装包</div>
        <n-input
          v-model:value="keyword"
          size="small"
          clearable
          :placeholder="`搜索 .${fileKind} 文件`"
        />

        <n-spin :show="loading">
          <div class="list">
            <n-empty
              v-if="filtered.length === 0 && !loading"
              :description="`没有可安装的 ${fileKind.toUpperCase()}`"
              class="empty"
            />
            <div v-for="item in filtered" :key="item.id" class="row">
              <span class="row-name" :title="item.name">{{ item.name }}</span>
              <span class="row-size">{{ formatSize(item.size) }}</span>
              <n-button
                size="tiny"
                type="primary"
                :loading="busyId === item.id"
                :disabled="busy && busyId !== item.id"
                @click="install(item.id, item.name)"
              >
                安装
              </n-button>
            </div>
          </div>
        </n-spin>
      </section>

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

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.block:first-child {
  padding-top: 0;
}

.block:last-of-type {
  border-bottom: none;
  padding-bottom: 0;
}

.block-title {
  font-size: 12px;
  font-weight: 600;
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

.tip {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}

.list {
  margin-top: 8px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--surface-2);
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
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

.step {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-dim);
}
</style>