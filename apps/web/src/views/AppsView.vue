<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import { api, type PackageRecord, type ServerInfo } from '../api';

const message = useMessage();
const dialog = useDialog();

const packages = ref<PackageRecord[]>([]);
const loading = ref(false);
const uploading = ref(false);
const uploadingName = ref('');
const keyword = ref('');
const kindFilter = ref<'all' | 'apk' | 'ipa'>('all');
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const renameTarget = ref<PackageRecord | null>(null);
const renameName = ref('');
const renaming = ref(false);
const storage = ref<ServerInfo['storage']>();

const storageText = computed(() =>
  storage.value?.driver === 'oss'
    ? `OSS · ${storage.value.bucket}/${storage.value.prefix}/packages`
    : '本地 .data/packages',
);

const counts = computed(() => ({
  apk: packages.value.filter((item) => item.kind === 'apk').length,
  ipa: packages.value.filter((item) => item.kind === 'ipa').length,
}));

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return packages.value.filter((item) => {
    if (kindFilter.value !== 'all' && item.kind !== kindFilter.value) return false;
    if (!text) return true;
    return item.name.toLowerCase().includes(text);
  });
});

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value: number): string {
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function download(record: PackageRecord): void {
  const link = document.createElement('a');
  link.href = api.packageFileUrl(record.id);
  link.download = record.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [result, info] = await Promise.all([
      api.listPackages(),
      api.serverInfo().catch(() => null),
    ]);
    packages.value = result.packages;
    if (info?.storage) storage.value = info.storage;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取安装包失败');
  } finally {
    loading.value = false;
  }
}

async function uploadFiles(files: File[]): Promise<void> {
  if (uploading.value) return;

  const valid = files.filter((file) => /\.(apk|ipa)$/i.test(file.name));
  if (valid.length < files.length) {
    message.warning('已忽略非 .apk / .ipa 文件');
  }
  if (valid.length === 0) return;

  uploading.value = true;
  let succeeded = 0;
  try {
    for (const file of valid) {
      uploadingName.value = file.name;
      try {
        await api.uploadPackage(file);
        succeeded += 1;
      } catch (error) {
        message.error(
          `${file.name}: ${error instanceof Error ? error.message : '上传失败'}`,
        );
      }
    }
  } finally {
    uploading.value = false;
    uploadingName.value = '';
  }

  if (succeeded > 0) {
    message.success(`已上传 ${succeeded} 个安装包`);
    await load();
  }
}

function pickFiles(): void {
  fileInput.value?.click();
}

function onFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  void uploadFiles(files);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  void uploadFiles(files);
}

function remove(record: PackageRecord): void {
  dialog.warning({
    title: '删除安装包',
    content: `确定删除 ${record.name} 吗？只影响服务器上的文件。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deletePackage(record.id);
        message.success('已删除');
        await load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

function openRename(record: PackageRecord): void {
  renameTarget.value = record;
  renameName.value = record.name;
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value;
  if (!target) return;

  const name = renameName.value.trim();
  if (!name) {
    message.error('名称不能为空');
    return;
  }
  if (!name.toLowerCase().endsWith(`.${target.kind}`)) {
    message.error(`后缀必须是 .${target.kind}`);
    return;
  }

  renaming.value = true;
  try {
    await api.renamePackage(target.id, name);
    message.success('已重命名');
    renameTarget.value = null;
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重命名失败');
  } finally {
    renaming.value = false;
  }
}

void load();
</script>

<template>
  <div class="apps-page">
    <div class="toolbar">
      <n-button type="primary" size="small" :loading="uploading" @click="pickFiles">
        上传安装包
      </n-button>
      <n-input
        v-model:value="keyword"
        size="small"
        clearable
        placeholder="搜索文件名"
        class="search"
      />
      <n-select
        v-model:value="kindFilter"
        size="small"
        class="kind-filter"
        :options="[
          { label: '全部类型', value: 'all' },
          { label: '仅 APK', value: 'apk' },
          { label: '仅 IPA', value: 'ipa' },
        ]"
      />
      <span class="stats">
        {{ packages.length }} 个 · APK {{ counts.apk }} · IPA {{ counts.ipa }}
      </span>
      <span class="storage" :title="storageText">{{ storageText }}</span>
      <input
        ref="fileInput"
        type="file"
        accept=".apk,.ipa"
        multiple
        hidden
        @change="onFileSelected"
      />
    </div>

    <div
      class="dropzone"
      :class="{ active: dragging }"
      @click="pickFiles"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <template v-if="uploading">
        正在上传 {{ uploadingName }} …
      </template>
      <template v-else>
        拖入 .apk / .ipa 文件，或点击选择（IPA 仅留存，不支持安装）
      </template>
    </div>

    <n-spin :show="loading">
      <n-empty
        v-if="!loading && packages.length === 0"
        class="empty"
        description="还没有上传安装包"
      />

      <div v-else class="list">
        <div v-for="record in filtered" :key="record.id" class="row">
          <div class="kind" :class="record.kind">
            {{ record.kind.toUpperCase() }}
          </div>
          <div class="info">
            <span class="name" :title="record.name">{{ record.name }}</span>
            <span class="meta">
              {{ formatSize(record.size) }} · {{ formatTime(record.uploadedAt) }}
            </span>
          </div>
          <n-tag v-if="record.kind === 'ipa'" size="tiny" :bordered="false" type="warning">
            不安装
          </n-tag>
          <div class="actions">
            <n-button size="tiny" @click="download(record)">下载</n-button>
            <n-button size="tiny" @click="openRename(record)">重命名</n-button>
            <n-button size="tiny" quaternary type="error" @click="remove(record)">
              删除
            </n-button>
          </div>
        </div>

        <div v-if="filtered.length === 0 && packages.length > 0" class="no-match">
          没有匹配的文件
        </div>
      </div>
    </n-spin>

    <n-modal
      :show="renameTarget !== null"
      preset="card"
      title="重命名安装包"
      style="width: 380px"
      :bordered="false"
      @update:show="renameTarget = null"
    >
      <n-input
        v-model:value="renameName"
        size="small"
        placeholder="文件名"
        @keyup.enter="submitRename"
      />
      <template #footer>
        <div class="modal-footer">
          <n-button size="small" @click="renameTarget = null">取消</n-button>
          <n-button size="small" type="primary" :loading="renaming" @click="submitRename">
            保存
          </n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.apps-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1080px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search {
  width: 240px;
}

.kind-filter {
  width: 120px;
}

.stats {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.storage {
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 64px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    background-color 0.12s ease;
}

.dropzone:hover,
.dropzone.active {
  border-color: #18181b;
  background: var(--surface-2);
  color: var(--text);
}

.list {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface);
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--surface-2);
}

.kind {
  flex: none;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #ffffff;
  background: #3f83f8;
}

.kind.ipa {
  background: #a855f7;
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 10px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.actions {
  flex: none;
  display: flex;
  gap: 4px;
}

.empty {
  padding: 60px 0;
}

.no-match {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>