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
  useMessage,
} from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import CopyValue from './CopyValue.vue';
import DeviceStats from './DeviceStats.vue';
import { api, thumbnailUrl } from '../api';
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
const { agents, refresh } = useFleet();

const publishedAt = ref<number | null>(null);
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
        <div class="preview">
          <n-image
            v-if="device.thumbnailAt > 0"
            :src="thumbnailUrl(device)"
            object-fit="contain"
            :img-props="{ style: 'max-height: 100%; max-width: 100%; object-fit: contain' }"
            show-toolbar
          />
          <div v-else class="preview-empty">
            <n-icon :size="20"><PhonePortraitOutline /></n-icon>
            <span>暂无图片</span>
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
          <n-descriptions-item label="平台">
            <CopyValue :value="platformLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="系统版本">
            <CopyValue :value="osLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="SDK">
            <CopyValue :value="device.sdk" />
          </n-descriptions-item>
          <n-descriptions-item label="CPU">
            <CopyValue :value="device.cpu" />
          </n-descriptions-item>
          <n-descriptions-item label="核心数">
            <CopyValue :value="coresLabel" />
          </n-descriptions-item>
          <n-descriptions-item label="内存">
            <CopyValue :value="formatMemory(device.memoryMb)" />
          </n-descriptions-item>
          <n-descriptions-item label="分辨率">
            <CopyValue :value="formatResolution(device.resolution)" />
          </n-descriptions-item>
          <n-descriptions-item label="所属节点">
            <CopyValue :value="agentName" />
          </n-descriptions-item>
          <n-descriptions-item label="UDID">
            <CopyValue :value="device.udid" mono />
          </n-descriptions-item>
          <n-descriptions-item label="最后在线">
            <CopyValue :value="formatDateTime(device.lastSeen)" />
          </n-descriptions-item>
          <n-descriptions-item label="发布时间">
            <n-date-picker
              v-model:value="publishedAt"
              type="month"
              size="small"
              clearable
              placeholder="未设置"
              @update:value="savePublishedAt"
            />
          </n-descriptions-item>
        </n-descriptions>

        <div class="stats-title">运行状态</div>
        <DeviceStats v-if="show" :device-id="device.id" />
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.stats-title {
  margin: 16px 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.preview {
  position: relative;
  height: 132px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.preview :deep(.n-image) {
  max-width: 100%;
  max-height: 100%;
}

.preview :deep(.n-image img) {
  max-height: 132px;
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