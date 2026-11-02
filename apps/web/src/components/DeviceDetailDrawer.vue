<script setup lang="ts">
import { computed } from 'vue';
import {
  NButton,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NIcon,
  NImage,
  NSpace,
  NTag,
} from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import CopyValue from './CopyValue.vue';
import { thumbnailUrl } from '../api';
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

const emit = defineEmits<{
  'update:show': [value: boolean];
  control: [device: DeviceSummary];
}>();

const { agents } = useFleet();

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

const capabilitiesText = computed(() =>
  props.device?.capabilities.join(', ') ?? '',
);

const bodyStyle = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '4px 20px 16px',
} as const;

const canControl = computed(
  () => props.device?.platform === 'android' && props.device.status === 'online',
);

function openControl(): void {
  if (!props.device || !canControl.value) return;
  emit('control', props.device);
}
</script>

<template>
  <n-drawer :show="show" :width="460" @update:show="emit('update:show', $event)">
    <n-drawer-content
      title="设备详情"
      closable
      :body-content-style="bodyStyle"
    >
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
            <n-icon :size="26"><PhonePortraitOutline /></n-icon>
            <span>暂无预览图</span>
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
          <span v-if="device.thumbnailAt > 0" class="preview-tip">
            点击图片可放大 / 缩放 / 全屏
          </span>
        </div>

        <div class="detail-scroll">
        <n-descriptions
          :column="1"
          label-placement="left"
          bordered
          size="small"
          :label-style="{ width: '84px' }"
        >
          <n-descriptions-item label="设备名称">
            <CopyValue :value="device.name" />
          </n-descriptions-item>
          <n-descriptions-item label="市场名称">
            <CopyValue :value="device.marketName" />
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
          <n-descriptions-item label="能力">
            <div class="caps">
              <n-space v-if="device.capabilities.length" :size="4">
                <n-tag
                  v-for="capability in device.capabilities"
                  :key="capability"
                  size="tiny"
                  :bordered="false"
                >
                  {{ capability }}
                </n-tag>
              </n-space>
              <span v-else>—</span>
              <CopyValue
                v-if="device.capabilities.length"
                icon-only
                :value="capabilitiesText"
              />
            </div>
          </n-descriptions-item>
        </n-descriptions>
        </div>
      </template>

      <template #footer>
        <n-space justify="end">
          <n-button type="primary" :disabled="!canControl" @click="openControl">
            控制
          </n-button>
        </n-space>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.preview {
  position: relative;
  flex: 1;
  min-height: 160px;
  display: grid;
  place-items: center;
  background: #000;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.preview :deep(.n-image) {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview :deep(.n-image img) {
  max-height: 100%;
  max-width: 100%;
  object-fit: contain;
  cursor: zoom-in;
}

.detail-scroll {
  flex: none;
  max-height: 46vh;
  overflow-y: auto;
}

.preview-tip {
  position: absolute;
  bottom: 6px;
  left: 8px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  pointer-events: none;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--border-strong);
  font-size: 11px;
}

.preview-status {
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