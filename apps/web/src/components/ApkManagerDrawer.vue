<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NSpin,
  NTabPane,
  NTabs,
  useDialog,
  useMessage,
} from 'naive-ui';
import { api, type PackageRecord } from '../api';
import { fileTimestamp, safeFileName } from '../utils/download';

const props = defineProps<{
  show: boolean;
  deviceId: string;
  deviceName: string;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const dialog = useDialog();

const tab = ref<'packages' | 'apps'>('packages');
const packages = ref<PackageRecord[]>([]);
const apps = ref<string[]>([]);
const loadingPackages = ref(false);
const loadingApps = ref(false);
const uploading = ref(false);
const busyId = ref<string | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);

const installTarget = computed(() => props.deviceName);

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    void loadPackages();
    void loadApps();
  },
);

async function loadPackages(): Promise<void> {
  loadingPackages.value = true;
  try {
    const result = await api.listPackages();
    packages.value = result.packages;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取安装包失败');
  } finally {
    loadingPackages.value = false;
  }
}

async function loadApps(): Promise<void> {
  if (!props.deviceId) return;
  loadingApps.value = true;
  try {
    const result = await api.listDeviceApps(props.deviceId);
    apps.value = result.packages;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取应用列表失败');
    apps.value = [];
  } finally {
    loadingApps.value = false;
  }
}

function formatSize(size: number): string {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function triggerDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function pickFile(): void {
  uploadInput.value?.click();
}

async function onFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.apk')) {
    message.error('请选择 .apk 文件');
    return;
  }

  uploading.value = true;
  try {
    await api.uploadPackage(file);
    message.success(`${file.name} 已上传`);
    await loadPackages();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '上传失败');
  } finally {
    uploading.value = false;
  }
}

async function install(record: PackageRecord): Promise<void> {
  busyId.value = record.id;
  try {
    await api.installPackage(props.deviceId, record.id);
    message.success(`已安装 ${record.name}`);
    await loadApps();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '安装失败');
  } finally {
    busyId.value = null;
  }
}

function removePackage(record: PackageRecord): void {
  dialog.warning({
    title: '删除安装包',
    content: `确定删除 ${record.name} 吗？只影响服务器上的文件。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deletePackage(record.id);
        message.success('已删除');
        await loadPackages();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

function uninstall(packageName: string): void {
  dialog.error({
    title: '卸载应用',
    content: `确定从「${installTarget.value}」卸载 ${packageName} 吗？`,
    positiveText: '卸载',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.uninstallDeviceApp(props.deviceId, packageName);
        message.success('已卸载');
        await loadApps();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '卸载失败');
      }
    },
  });
}

function exportApp(packageName: string): void {
  triggerDownload(api.deviceAppExportUrl(props.deviceId, packageName));
  message.success(`正在导出 ${packageName}.apk`);
}

function exportPackage(record: PackageRecord): void {
  triggerDownload(api.packageFileUrl(record.id));
  message.success(`正在导出 ${record.name}`);
}
</script>

<template>
  <n-drawer :show="show" :width="620" @update:show="emit('update:show', $event)">
    <n-drawer-content title="APK 管理" closable>
      <n-tabs v-model:value="tab" type="line" animated>
        <n-tab-pane name="packages" :tab="`安装包 (${packages.length})`">
          <div class="toolbar">
            <n-button size="small" :loading="uploading" @click="pickFile">
              上传 APK
            </n-button>
            <n-button size="small" quaternary @click="loadPackages">刷新</n-button>
            <input
              ref="uploadInput"
              type="file"
              accept=".apk"
              hidden
              @change="onFileSelected"
            />
            <span class="hint">安装到：{{ installTarget }}</span>
          </div>

          <n-spin :show="loadingPackages">
            <div class="list">
              <n-empty
                v-if="packages.length === 0 && !loadingPackages"
                description="还没有上传安装包"
                class="empty"
              />
              <div v-for="record in packages" :key="record.id" class="row">
                <div class="info">
                  <span class="name" :title="record.name">{{ record.name }}</span>
                  <span class="meta">
                    {{ formatSize(record.size) }} · {{ formatTime(record.uploadedAt) }}
                  </span>
                </div>
                <div class="actions">
                  <n-button
                    size="tiny"
                    type="primary"
                    :loading="busyId === record.id"
                    @click="install(record)"
                  >
                    安装
                  </n-button>
                  <n-button size="tiny" @click="exportPackage(record)">导出</n-button>
                  <n-button size="tiny" quaternary type="error" @click="removePackage(record)">
                    删除
                  </n-button>
                </div>
              </div>
            </div>
          </n-spin>
        </n-tab-pane>

        <n-tab-pane name="apps" :tab="`已安装应用 (${apps.length})`">
          <div class="toolbar">
            <n-button size="small" quaternary @click="loadApps">刷新</n-button>
            <span class="hint">仅列出第三方应用</span>
          </div>

          <n-spin :show="loadingApps">
            <div class="list">
              <n-empty
                v-if="apps.length === 0 && !loadingApps"
                description="没有读取到应用"
                class="empty"
              />
              <div v-for="pkg in apps" :key="pkg" class="row">
                <div class="info">
                  <span class="name mono" :title="pkg">{{ pkg }}</span>
                </div>
                <div class="actions">
                  <n-button size="tiny" @click="exportApp(pkg)">导出</n-button>
                  <n-button size="tiny" quaternary type="error" @click="uninstall(pkg)">
                    卸载
                  </n-button>
                </div>
              </div>
            </div>
          </n-spin>
        </n-tab-pane>
      </n-tabs>
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

.hint {
  font-size: 11px;
  color: var(--text-faint);
  margin-left: auto;
}

.list {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--surface-2);
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-muted);
}

.meta {
  font-size: 10px;
  color: var(--text-faint);
}

.actions {
  flex: none;
  display: flex;
  gap: 4px;
}

.empty {
  padding: 40px 0;
}
</style>