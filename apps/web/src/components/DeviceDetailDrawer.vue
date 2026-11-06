<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NIcon,
  NImage,
  NSpace,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import { LogoAndroid, LogoApple } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import CopyValue from './CopyValue.vue';
import DeviceStats from './DeviceStats.vue';
import { api, thumbnailUrl, type DeviceRuntime } from '../api';
import { useAuth } from '../stores/auth';
import { useFleet } from '../stores/fleet';
import {
  formatDateTime,
  formatMemory,
  formatResolution,
} from '../utils/format';

const props = defineProps<{
  show: boolean;
  device: DeviceSummary | null;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const dialog = useDialog();
const { isAdmin } = useAuth();
const { agents, refresh } = useFleet();

/** 管理员 / 超管删除设备记录（不影响手机上的应用）。 */
function confirmDelete(): void {
  const current = props.device;
  if (!current) return;
  dialog.warning({
    title: '删除设备',
    content: `确定删除「${current.name}」的设备记录吗？只影响平台数据，不会卸载手机上的应用。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteDevice(current.id);
        message.success('已删除设备');
        emit('update:show', false);
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

/** 只展示手动上传的图片，自动截图不放详情里。 */
const manualThumbnail = computed(
  () =>
    Boolean(props.device) &&
    (props.device?.thumbnailAt ?? 0) > 0 &&
    props.device?.thumbnailSource === 'manual',
);

const publishedAt = ref<number | null>(null);
const runtime = ref<DeviceRuntime | null>(null);

/** 网络信息来自运行状态接口，详情里也展示一份。 */
async function loadRuntime(): Promise<void> {
  const device = props.device;
  if (!device) {
    runtime.value = null;
    return;
  }
  try {
    runtime.value = await api.getDeviceRuntime(device.id);
  } catch {
    runtime.value = null;
  }
}

watch(
  () => [props.show, props.device?.id] as const,
  () => {
    if (props.show) void loadRuntime();
  },
  { immediate: true },
);

const wifiLabel = computed(() => {
  const wifi = runtime.value?.wifi;
  if (!wifi) return undefined;
  if (!wifi.connected) return '未连接';
  return wifi.ssid ?? '已连接（未获取到名称）';
});

const publishedAgoText = computed(() => {
  const timestamp = props.device?.publishedAt ?? 0;
  if (timestamp <= 0) return '';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
});
const imageInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

watch(
  () => props.device,
  (device) => {
    publishedAt.value = device && device.publishedAt > 0 ? device.publishedAt : null;
  },
  { immediate: true },
);

const agentName = computed(() => {
  const device = props.device;
  if (!device) return '—';
  return agents.value.find((agent) => agent.id === device.agentId)?.name ?? '未知节点';
});

const statusMeta = computed(() => {
  switch (props.device?.status) {
    case 'online':
      return { type: 'success' as const, label: '在线' };
    case 'unauthorized':
      return { type: 'warning' as const, label: '未授权' };
    default:
      return { type: 'default' as const, label: '离线' };
  }
});

const platformLabel = computed(() =>
  props.device?.platform === 'ios' ? 'iOS' : 'Android',
);

const osLabel = computed(() => {
  const device = props.device;
  if (!device?.osVersion) return undefined;
  return device.platform === 'ios'
    ? `iOS ${device.osVersion}`
    : `Android ${device.osVersion}`;
});

const coresLabel = computed(() => {
  const cores = props.device?.cpuCores;
  return cores ? `${cores} 核` : undefined;
});

const rootedLabel = computed(() => {
  const rooted = props.device?.rooted;
  if (rooted === undefined) return '—';
  return rooted ? '已 Root' : '未 Root';
});

const title = computed(() =>
  props.device ? `设备详情 · ${props.device.name}` : '设备详情',
);

async function savePublishedAt(value: number | null): Promise<void> {
  const device = props.device;
  if (!device) return;
  try {
    await api.updateDevice(device.id, { publishedAt: value ?? 0 });
    message.success('发布时间已保存');
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  }
}

function pickImage(): void {
  imageInput.value?.click();
}

function toJpeg(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 720 / image.width);
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error('画布不可用'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('图片转换失败'))),
        'image/jpeg',
        0.85,
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    image.src = url;
  });
}

/** 管理员锁定 / 解锁设备；离线设备也能操作。 */
async function toggleLock(): Promise<void> {
  const device = props.device;
  if (!device) return;

  const next = !device.locked;
  try {
    await api.updateDevice(device.id, { locked: next });
    message.success(
      next ? '已锁定设备，任何人都不能控制或查看' : '已解除锁定',
    );
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败');
  }
}

async function onImageSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !props.device) return;

  uploading.value = true;
  try {
    const jpeg = await toJpeg(file);
    await api.uploadDeviceThumbnail(props.device.id, jpeg);
    message.success('设备图片已更新');
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '上传失败');
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <n-drawer :show="show" :width="520" @update:show="emit('update:show', $event)">
    <n-drawer-content :title="title" closable>
      <template v-if="device">
        <div class="lock-bar">
          <n-tag
            v-if="device.locked"
            size="small"
            type="warning"
            :bordered="false"
            round
          >
            已锁定 · 任何人不能控制或查看
          </n-tag>
          <span v-else class="lock-hint">未锁定</span>
          <span class="lock-spacer" />
          <n-button
            v-if="isAdmin"
            size="tiny"
            :type="device.locked ? 'warning' : 'default'"
            :ghost="device.locked"
            @click="toggleLock"
          >
            {{ device.locked ? '解除锁定' : '锁定设备' }}
          </n-button>
          <n-button
            v-if="isAdmin"
            size="tiny"
            type="error"
            ghost
            @click="confirmDelete"
          >
            删除设备
          </n-button>
        </div>

        <div class="detail-top">
          <div class="preview" :class="{ empty: !manualThumbnail }">
            <n-image
              v-if="manualThumbnail"
              :src="thumbnailUrl(device)"
              object-fit="contain"
              :img-props="{ style: 'max-height: 100%; max-width: 100%; object-fit: contain' }"
              show-toolbar
            />
            <div v-else class="preview-empty" :class="device.platform">
              <n-icon :size="46">
                <LogoAndroid v-if="device.platform === 'android'" />
                <LogoApple v-else />
              </n-icon>
              <span>未上传图片</span>
            </div>

            <n-tag
              class="preview-status"
              size="small"
              :type="statusMeta.type"
              :bordered="false"
              round
            >
              {{ statusMeta.label }}
            </n-tag>
            <n-button
              class="preview-upload"
              size="tiny"
              :loading="uploading"
              @click="pickImage"
            >
              上传图片
            </n-button>
            <input
              ref="imageInput"
              type="file"
              accept="image/*"
              hidden
              @change="onImageSelected"
            />
          </div>

          <div class="stats-col">
            <div class="stats-title">运行状态</div>
            <DeviceStats v-if="show" :device-id="device.id" />
          </div>
        </div>

        <div class="stats-title">设备信息</div>
        <n-descriptions
          :column="1"
          label-placement="left"
          bordered
          size="small"
          :label-style="{ width: '88px' }"
        >
          <n-descriptions-item label="设备名称">
            <CopyValue :value="device.name" />
          </n-descriptions-item>
          <n-descriptions-item label="品牌">
            <CopyValue :value="device.brand" />
          </n-descriptions-item>
          <n-descriptions-item label="接入方式">
            <n-tag
              size="small"
              :type="device.capabilities?.includes('portal') ? 'success' : 'default'"
              :bordered="false"
              round
            >
              {{ device.capabilities?.includes('portal') ? '设备无线直连（无需宿主机）' : '宿主机 Agent' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="平台">
            <CopyValue :value="platformLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="系统版本">
            <CopyValue :value="osLabel" />
          </n-descriptions-item>
          <n-descriptions-item v-if="device.marketName" label="市场名称">
            <CopyValue :value="device.marketName" />
          </n-descriptions-item>
          <n-descriptions-item v-if="device.model" label="型号">
            <CopyValue :value="device.model" mono />
          </n-descriptions-item>
          <n-descriptions-item v-if="device.sdk" label="API Level">
            <CopyValue :value="String(device.sdk)" />
          </n-descriptions-item>
          <n-descriptions-item label="CPU">
            <CopyValue :value="device.cpu" />
          </n-descriptions-item>
          <n-descriptions-item label="CPU 架构">
            <CopyValue :value="device.cpuArch" />
          </n-descriptions-item>
          <n-descriptions-item label="CPU 代号">
            <CopyValue :value="device.cpuCode" />
          </n-descriptions-item>
          <n-descriptions-item label="核心数">
            <CopyValue :value="coresLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="内存">
            <CopyValue :value="formatMemory(device.memoryMb)" />
          </n-descriptions-item>
          <n-descriptions-item label="Root">
            <CopyValue :value="rootedLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="分辨率">
            <CopyValue :value="formatResolution(device.resolution)" />
          </n-descriptions-item>
          <n-descriptions-item label="WiFi">
            <CopyValue :value="wifiLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="IP 地址">
            <CopyValue :value="runtime?.wifi?.ip ?? undefined" />
          </n-descriptions-item>
          <n-descriptions-item label="所属节点">
            <CopyValue :value="agentName" />
          </n-descriptions-item>
          <n-descriptions-item v-if="device.platform === 'ios'" label="WDA 转发">
            <CopyValue
              :value="
                device.wdaPort
                  ? `节点「${agentName}」 · :${device.wdaPort}`
                  : '未分配'
              "
            />
          </n-descriptions-item>
          <n-descriptions-item label="UDID">
            <CopyValue :value="device.udid" mono />
          </n-descriptions-item>
          <n-descriptions-item label="最后在线">
            <CopyValue :value="formatDateTime(device.lastSeen)" />
          </n-descriptions-item>
          <n-descriptions-item label="发布时间">
            <n-space align="center" :size="8">
              <n-date-picker
                v-model:value="publishedAt"
                type="month"
                size="small"
                clearable
                placeholder="未设置"
                @update:value="savePublishedAt"
              />
              <n-tag
                v-if="publishedAgoText"
                size="tiny"
                :bordered="false"
                round
              >
                {{ publishedAgoText }}
              </n-tag>
            </n-space>
          </n-descriptions-item>
        </n-descriptions>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.stats-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.stats-title + .n-descriptions {
  margin-top: 0;
}

.detail-top {
  display: flex;
  align-items: stretch;
  gap: 14px;
  margin-bottom: 16px;
}

.lock-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.lock-hint {
  font-size: 12px;
  color: var(--text-faint);
}

.lock-spacer {
  flex: 1;
}

.stats-col {
  flex: 1;
  min-width: 0;
}

.preview {
  position: relative;
  flex: none;
  width: 190px;
  min-height: 150px;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.preview.empty {
  background: linear-gradient(180deg, #fafafa 0%, #f4f4f5 100%);
}

.preview :deep(.n-image) {
  max-width: 100%;
  max-height: 100%;
}

.preview :deep(.n-image img) {
  max-height: 170px;
  max-width: 100%;
  object-fit: contain;
  cursor: zoom-in;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: #52525b;
  font-size: 11px;
}

.preview-status {
  position: absolute;
  top: 8px;
  left: 8px;
}

.preview-upload {
  position: absolute;
  top: 8px;
  right: 8px;
}

.caps {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>