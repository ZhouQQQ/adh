<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpin,
  useDialog,
  useMessage,
} from 'naive-ui';
import { DocumentOutline, FolderOutline } from '@vicons/ionicons5';
import { api, type DeviceFileEntry } from '../api';
import { saveBlob } from '../utils/download';

const ROOT = '/storage/emulated/0';

const props = defineProps<{
  show: boolean;
  deviceId: string;
  deviceName: string;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const dialog = useDialog();

const path = ref(ROOT);
const entries = ref<DeviceFileEntry[]>([]);
const loading = ref(false);
const uploading = ref(false);
const downloading = ref<string | null>(null);
const busy = ref(false);
const errorText = ref<string | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);

const selected = ref<string[]>([]);
const clipboard = ref<{ mode: 'copy' | 'move'; paths: string[] } | null>(null);

type SortKey = 'name' | 'size' | 'mtime';
const sortKey = ref<SortKey>('name');
const sortDir = ref<'asc' | 'desc'>('asc');
const archiving = ref(false);

const sortedEntries = computed(() => {
  const direction = sortDir.value === 'asc' ? 1 : -1;
  return [...entries.value].sort((a, b) => {
    // 目录始终排前面
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sortKey.value === 'size') return (a.size - b.size) * direction;
    if (sortKey.value === 'mtime') {
      return a.mtime.localeCompare(b.mtime) * direction;
    }
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) * direction;
  });
});

const renameShow = ref(false);
const renameValue = ref('');
const renameTarget = ref<DeviceFileEntry | null>(null);

type PreviewKind = 'image' | 'text' | 'video' | 'audio' | 'pdf';

const previewShow = ref(false);
const previewLoading = ref(false);
const previewKind = ref<PreviewKind | null>(null);
const previewEntry = ref<DeviceFileEntry | null>(null);
const previewUrl = ref<string | null>(null);
const previewText = ref('');

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'];
const TEXT_EXT = [
  'txt', 'log', 'json', 'xml', 'md', 'csv', 'yaml', 'yml', 'ini', 'conf',
  'js', 'ts', 'java', 'kt', 'py', 'sh', 'html', 'css', 'prop',
];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', '3gp'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
const PDF_EXT = ['pdf'];

/** 常见可预览格式，返回预览类型；其他返回 null 走下载。 */
function detectPreview(name: string, size: number): PreviewKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXT.includes(ext)) return size > 20 * 1024 * 1024 ? null : 'image';
  if (TEXT_EXT.includes(ext)) return size > 2 * 1024 * 1024 ? null : 'text';
  if (PDF_EXT.includes(ext)) return size > 30 * 1024 * 1024 ? null : 'pdf';
  if (VIDEO_EXT.includes(ext)) return size > 80 * 1024 * 1024 ? null : 'video';
  if (AUDIO_EXT.includes(ext)) return size > 40 * 1024 * 1024 ? null : 'audio';
  return null;
}

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean);
  const list = [{ name: '根目录', path: '/' }];
  parts.forEach((part, index) => {
    list.push({ name: part, path: `/${parts.slice(0, index + 1).join('/')}` });
  });
  return list;
});

const allSelected = computed(
  () => entries.value.length > 0 && selected.value.length === entries.value.length,
);

async function load(target: string): Promise<void> {
  if (!props.deviceId) return;
  loading.value = true;
  errorText.value = null;
  try {
    const result = await api.listFiles(props.deviceId, target);
    path.value = result.path;
    entries.value = result.entries;
    selected.value = [];
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '读取目录失败';
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.show,
  (visible) => {
    if (visible) void load(ROOT);
  },
);

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fullPath(name: string): string {
  return path.value === '/' ? `/${name}` : `${path.value}/${name}`;
}

function toggleSelect(name: string, checked: boolean): void {
  if (checked) {
    if (!selected.value.includes(name)) {
      selected.value = [...selected.value, name];
    }
    return;
  }
  selected.value = selected.value.filter((item) => item !== name);
}

function toggleSelectAll(): void {
  selected.value = allSelected.value
    ? []
    : entries.value.map((entry) => entry.name);
}

function onEntryClick(entry: DeviceFileEntry): void {
  if (entry.isDir) {
    void load(fullPath(entry.name));
    return;
  }
  const kind = detectPreview(entry.name, entry.size);
  if (!kind) {
    void download(entry);
    return;
  }
  void openPreview(entry, kind);
}

async function openPreview(
  entry: DeviceFileEntry,
  kind: PreviewKind,
): Promise<void> {
  cleanupPreview();
  previewEntry.value = entry;
  previewKind.value = kind;
  previewShow.value = true;
  previewLoading.value = true;

  try {
    const { blob } = await api.downloadDeviceFile(
      props.deviceId,
      fullPath(entry.name),
    );
    if (kind === 'text') {
      previewText.value = await blob.text();
    } else {
      previewUrl.value = URL.createObjectURL(blob);
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '预览失败');
    previewShow.value = false;
  } finally {
    previewLoading.value = false;
  }
}

function cleanupPreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = null;
  }
  previewText.value = '';
  previewKind.value = null;
  previewEntry.value = null;
}

function downloadPreview(): void {
  if (previewEntry.value) void download(previewEntry.value);
}

async function download(entry: DeviceFileEntry): Promise<void> {
  downloading.value = entry.name;
  try {
    const { blob, name } = await api.downloadDeviceFile(
      props.deviceId,
      fullPath(entry.name),
    );
    saveBlob(blob, name);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '下载失败');
  } finally {
    downloading.value = null;
  }
}

async function downloadArchive(): Promise<void> {
  if (selected.value.length === 0) return;
  archiving.value = true;
  try {
    const blob = await api.downloadDeviceFilesZip(
      props.deviceId,
      selected.value.map(fullPath),
    );
    saveBlob(blob, `files-${Date.now()}.zip`);
    message.success(`已打包 ${selected.value.length} 项`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '打包下载失败');
  } finally {
    archiving.value = false;
  }
}

function pickUpload(): void {
  uploadInput.value?.click();
}

async function onUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  uploading.value = true;
  try {
    await api.uploadDeviceFile(props.deviceId, path.value, file);
    message.success(`已上传 ${file.name}`);
    await load(path.value);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '上传失败');
  } finally {
    uploading.value = false;
  }
}

function startClipboard(mode: 'copy' | 'move'): void {
  if (selected.value.length === 0) {
    message.warning('请先选择文件');
    return;
  }
  clipboard.value = {
    mode,
    paths: selected.value.map(fullPath),
  };
  message.success(
    `已${mode === 'copy' ? '复制' : '剪切'} ${selected.value.length} 项，进入目标目录后点「粘贴」`,
  );
}

async function paste(): Promise<void> {
  const current = clipboard.value;
  if (!current) return;

  busy.value = true;
  try {
    await api.pasteDeviceFiles(
      props.deviceId,
      current.paths,
      path.value,
      current.mode,
    );
    message.success('已粘贴');
    if (current.mode === 'move') clipboard.value = null;
    await load(path.value);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '粘贴失败');
  } finally {
    busy.value = false;
  }
}

function removeSelected(): void {
  if (selected.value.length === 0) return;
  const targets = selected.value.map(fullPath);

  dialog.warning({
    title: '删除文件',
    content: `确定删除选中的 ${targets.length} 项吗？该操作不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      busy.value = true;
      try {
        await api.deleteDeviceFiles(props.deviceId, targets);
        message.success('已删除');
        await load(path.value);
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      } finally {
        busy.value = false;
      }
    },
  });
}

function openRename(entry: DeviceFileEntry): void {
  renameTarget.value = entry;
  renameValue.value = entry.name;
  renameShow.value = true;
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value;
  if (!target) return;
  const value = renameValue.value.trim();
  if (!value || value === target.name) {
    renameShow.value = false;
    return;
  }

  busy.value = true;
  try {
    await api.renameDeviceFile(props.deviceId, fullPath(target.name), value);
    message.success('已重命名');
    renameShow.value = false;
    await load(path.value);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重命名失败');
  } finally {
    busy.value = false;
  }
}

const selectedSingle = computed(() =>
  selected.value.length === 1
    ? entries.value.find((entry) => entry.name === selected.value[0]) ?? null
    : null,
);
</script>

<template>
  <n-drawer :show="show" :width="620" @update:show="emit('update:show', $event)">
    <n-drawer-content :title="`文件管理 · ${deviceName}`" closable>
      <div class="crumbs">
        <button
          v-for="(crumb, index) in crumbs"
          :key="crumb.path"
          type="button"
          class="crumb"
          @click="load(crumb.path)"
        >
          {{ crumb.name }}
          <span v-if="index < crumbs.length - 1" class="sep">/</span>
        </button>
      </div>

      <div class="toolbar">
        <n-checkbox
          :checked="allSelected"
          :disabled="entries.length === 0"
          @update:checked="toggleSelectAll"
        >
          {{ selected.length > 0 ? `已选 ${selected.length}` : '全选' }}
        </n-checkbox>

        <span class="divider" />

        <n-button size="tiny" :disabled="selected.length === 0" @click="startClipboard('copy')">
          复制
        </n-button>
        <n-button size="tiny" :disabled="selected.length === 0" @click="startClipboard('move')">
          剪切
        </n-button>
        <n-button
          size="tiny"
          :disabled="!clipboard"
          :loading="busy"
          @click="paste"
        >
          粘贴{{ clipboard ? ` (${clipboard.paths.length})` : '' }}
        </n-button>
        <n-button
          size="tiny"
          :disabled="!selectedSingle"
          @click="selectedSingle && openRename(selectedSingle)"
        >
          重命名
        </n-button>
        <n-button
          size="tiny"
          type="error"
          ghost
          :disabled="selected.length === 0"
          @click="removeSelected"
        >
          删除
        </n-button>

        <n-button
          size="tiny"
          :disabled="selected.length === 0"
          :loading="archiving"
          @click="downloadArchive"
        >
          打包下载
        </n-button>

        <span class="divider" />

        <span class="sort-label">排序</span>
        <n-select
          v-model:value="sortKey"
          size="tiny"
          class="sort-select"
          :options="[
            { label: '名称', value: 'name' },
            { label: '大小', value: 'size' },
            { label: '时间', value: 'mtime' },
          ]"
        />
        <n-button
          size="tiny"
          quaternary
          :title="sortDir === 'asc' ? '升序' : '降序'"
          @click="sortDir = sortDir === 'asc' ? 'desc' : 'asc'"
        >
          {{ sortDir === 'asc' ? '↑' : '↓' }}
        </n-button>

        <span class="divider" />

        <n-button size="tiny" :loading="uploading" @click="pickUpload">
          上传
        </n-button>
        <n-button size="tiny" quaternary :loading="loading" @click="load(path)">
          刷新
        </n-button>
        <input ref="uploadInput" type="file" hidden @change="onUpload" />
      </div>

      <n-spin :show="loading">
        <div class="list">
          <n-empty v-if="errorText" :description="errorText" class="empty" />
          <n-empty
            v-else-if="entries.length === 0 && !loading"
            description="空目录"
            class="empty"
          />
          <div
            v-for="entry in sortedEntries"
            :key="entry.name"
            class="row"
            :class="{
              busy: downloading === entry.name,
              selected: selected.includes(entry.name),
            }"
            @click="onEntryClick(entry)"
          >
            <n-checkbox
              :checked="selected.includes(entry.name)"
              size="small"
              @click.stop
              @update:checked="toggleSelect(entry.name, $event)"
            />
            <n-icon
              :component="entry.isDir ? FolderOutline : DocumentOutline"
              :size="16"
              class="icon"
            />
            <span class="name">{{ entry.name }}</span>
            <button
              type="button"
              class="row-action"
              title="重命名"
              @click.stop="openRename(entry)"
            >
              改名
            </button>
            <span class="meta">
              {{ entry.isDir ? entry.mtime : formatSize(entry.size) }}
            </span>
          </div>
        </div>
      </n-spin>

      <n-modal
        v-model:show="previewShow"
        preset="card"
        :title="previewEntry?.name ?? '预览'"
        style="width: min(920px, 92vw)"
        :bordered="false"
        @after-leave="cleanupPreview"
      >
        <div class="preview-body">
          <n-spin :show="previewLoading">
            <img
              v-if="previewKind === 'image' && previewUrl"
              :src="previewUrl"
              class="preview-image"
              alt=""
            />
            <pre v-else-if="previewKind === 'text'" class="preview-text">{{ previewText }}</pre>
            <iframe
              v-else-if="previewKind === 'pdf' && previewUrl"
              :src="previewUrl"
              class="preview-frame"
              title="PDF 预览"
            />
            <video
              v-else-if="previewKind === 'video' && previewUrl"
              :src="previewUrl"
              class="preview-media"
              controls
              autoplay
            />
            <audio
              v-else-if="previewKind === 'audio' && previewUrl"
              :src="previewUrl"
              class="preview-audio"
              controls
              autoplay
            />
          </n-spin>
        </div>

        <template #footer>
          <div class="modal-footer">
            <n-button quaternary @click="previewShow = false">关闭</n-button>
            <n-button type="primary" @click="downloadPreview">下载</n-button>
          </div>
        </template>
      </n-modal>

      <n-modal
        v-model:show="renameShow"
        preset="card"
        title="重命名"
        style="width: 420px"
      >
        <n-input v-model:value="renameValue" placeholder="新名称" @keyup.enter="submitRename" />
        <template #footer>
          <div class="modal-footer">
            <n-button quaternary @click="renameShow = false">取消</n-button>
            <n-button type="primary" :loading="busy" @click="submitRename">
              保存
            </n-button>
          </div>
        </template>
      </n-modal>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-bottom: 8px;
  font-size: 12px;
}

.crumb {
  border: none;
  background: transparent;
  padding: 2px 4px;
  border-radius: 4px;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
}

.crumb:hover {
  background: var(--surface-2);
  color: var(--text);
}

.sep {
  color: var(--text-faint);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  /* 列表很长时操作按钮始终可见 */
  position: sticky;
  top: -1px;
  z-index: 6;
  box-shadow: 0 4px 10px rgba(9, 9, 11, 0.04);
}

.sort-label {
  font-size: 11px;
  color: var(--text-faint);
}

.sort-select {
  width: 84px;
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 2px;
}

.list {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--surface-2);
}

.row.selected {
  background: #f0f0f2;
}

.row.busy {
  opacity: 0.5;
}

.icon {
  color: var(--text-dim);
  flex: none;
}

.name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-action {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.row:hover .row-action {
  opacity: 1;
}

.row-action:hover {
  background: var(--border);
  color: var(--text);
}

.meta {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  padding: 32px 0;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.preview-body {
  min-height: 200px;
  max-height: 72vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.preview-image {
  max-width: 100%;
  max-height: 72vh;
  object-fit: contain;
  display: block;
}

.preview-text {
  margin: 0;
  padding: 14px;
  width: 100%;
  max-height: 72vh;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-all;
}

.preview-frame {
  width: 100%;
  height: 70vh;
  border: none;
}

.preview-media {
  max-width: 100%;
  max-height: 70vh;
}

.preview-audio {
  width: 80%;
}
</style>