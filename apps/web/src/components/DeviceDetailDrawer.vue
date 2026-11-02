<script setup lang="ts">
import { computed } from 'vue';
import {
  NButton,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NIcon,
  NSpace,
  NTag,
} from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import { thumbnailUrl } from '../api';
import { useFleet } from '../stores/fleet';
import { formatAgo, formatMemory, formatResolution } from '../utils/format';

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
  if (!device?.osVersion) return '—';
  return device.platform === 'ios'
    ? `iOS ${device.osVersion}`
    : `Android ${device.osVersion}`;
});

const canControl = computed(
  () => props.device?.platform === 'android' && props.device.status === 'online',
);

function openControl(): void {
  if (!props.device || !canControl.value) return;
  emit('control', props.device);
}
</script>

<template>
  <n-drawer :show="show" :width="520" @update:show="emit('update:show', $event)">
    <n-drawer-content title="设备详情" closable>
      <template v-if="device">
        <div class="preview">
          <img
            v-if="device.thumbnailAt > 0"
            :src="thumbnailUrl(device)"
            alt=""
          />
          <div v-else class="preview-empty">
            <n-icon :size="28"><PhonePortraitOutline /></n-icon>
            <span>暂无预览图</span>
          </div>
          <n-tag class="preview-status" size="small" :type="statusMeta.type" :bordered="false" round>
            {{ statusMeta.label }}
          </n-tag>
        </div>

        <n-descriptions
          :column="1"
          label-placement="left"
          bordered
          size="small"
          :label-style="{ width: '92px' }"
        >
          <n-descriptions-item label="设备名称">{{ device.name }}</n-descriptions-item>
          <n-descriptions-item label="市场名称">
            {{ device.marketName ?? '—' }}
          </n-descriptions-item>
          <n-descriptions-item label="品牌型号">
            {{ [device.brand, device.model].filter(Boolean).join(' / ') || '—' }}
          </n-descriptions-item>
          <n-descriptions-item label="平台">{{ platformLabel }}</n-descriptions-item>
          <n-descriptions-item label="系统版本">{{ osLabel }}</n-descriptions-item>
          <n-descriptions-item label="SDK">
            {{ device.sdk ?? '—' }}
          </n-descriptions-item>
          <n-descriptions-item label="CPU">{{ device.cpu ?? '—' }}</n-descriptions-item>
          <n-descriptions-item label="核心数">
            {{ device.cpuCores ? `${device.cpuCores} 核` : '—' }}
          </n-descriptions-item>
          <n-descriptions-item label="内存">
            {{ formatMemory(device.memoryMb) }}
          </n-descriptions-item>
          <n-descriptions-item label="分辨率">
            {{ formatResolution(device.resolution) }}
          </n-descriptions-item>
          <n-descriptions-item label="所属节点">{{ agentName }}</n-descriptions-item>
          <n-descriptions-item label="UDID">
            <code class="udid">{{ device.udid }}</code>
          </n-descriptions-item>
          <n-descriptions-item label="最后在线">
            {{ device.status === 'online' ? '在线' : formatAgo(device.lastSeen) }}
          </n-descriptions-item>
          <n-descriptions-item label="能力">
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
          </n-descriptions-item>
        </n-descriptions>
      </template>

      <template #footer>
        <n-space justify="end">
          <n-button
            type="primary"
            :disabled="!canControl"
            @click="openControl"
          >
            实时控制
          </n-button>
        </n-space>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.preview {
  position: relative;
  display: grid;
  place-items: center;
  height: 260px;
  margin-bottom: 16px;
  background: #000;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
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

.udid {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
}
</style>