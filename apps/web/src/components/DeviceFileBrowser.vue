<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NSpin,
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

const path = ref(ROOT);
const entries = ref<DeviceFileEntry[]>([]);
const loading = ref(false);
const uploading = ref(false);
const downloading = ref<string | null>(null);
const errorText = ref<string | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean);
  const list = [{ name: '根目录', path: '/' }];
  parts.forEach((part, index) => {
    list.push({ name: part, path: `/${parts.slice(0, index + 1).join('/')}` });
  });
  return list;
});

async function load(target: string): Promise<void> {
  if (!props.deviceId) return;
  loading.value = true;
  errorText.value = null;
  try {
    const result = await api.listFiles(props.deviceId, target);
    path.value = result.path;
    entries.value = result.entries;
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

function onEntryClick(entry: DeviceFileEntry): void {
  if (entry.isDir) {
    void load(fullPath(entry.name));
    return;
  }
  void download(entry);
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
</script>

<template>
  <n-drawer :show="show" :width="560" @update:show="emit('update:show', $event)">
    <n-drawer-content :title="`设备文件 · ${deviceName}`" closable>
      <div class="toolbar">
        <n-button size="tiny" :disabled="path === '/'" @click="load(crumbs[crumbs.length - 2]?.path ?? '/')">
          上一级
        </n-button>
        <n-button size="tiny" :loading="uploading" @click="pickUpload">
          上传文件
        </n-button>
        <n-button size="tiny" quaternary :loading="loading" @click="load(path)">
          刷新
        </n-button>
        <input ref="uploadInput" type="file" hidden @change="onUpload" />
      </div>

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

      <n-spin :show="loading">
        <div class="list">
          <n-empty
            v-if="errorText"
            :description="errorText"
            class="empty"
          />
          <n-empty
            v-else-if="entries.length === 0 && !loading"
            description="空目录"
            class="empty"
          />
          <div
            v-for="entry in entries"
            :key="entry.name"
            class="row"
            :class="{ busy: downloading === entry.name }"
            @click="onEntryClick(entry)"
          >
            <n-icon
              :component="entry.isDir ? FolderOutline : DocumentOutline"
              :size="16"
              class="icon"
            />
            <span class="name">{{ entry.name }}</span>
            <span class="meta">
              {{ entry.isDir ? entry.mtime : formatSize(entry.size) }}
            </span>
          </div>
        </div>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-bottom: 10px;
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

.list {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
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

.meta {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  padding: 32px 0;
}
</style>