<script setup lang="ts">
import { computed, ref } from 'vue';
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
  useMessage,
} from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import CopyValue from './CopyValue.vue';
import DeviceFileBrowser from './DeviceFileBrowser.vue';
import { thumbnailUrl } from '../api';
import { useFleet } from '../stores/fleet';
import { copyText } from '../utils/clipboard';
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

const message = useMessage();
const { agents } = useFleet();

const fileShow = ref(false);

const bodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  padding: '4px 20px 16px',
  overflow: 'hidden',
} as const;

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

const canControl = computed(
  () => props.device?.platform === 'android' && props.device.status === 'online',
);

const title = computed(() =>
  props.device ? `设备详情 · ${props.device.name}` : '设备详情',
);

function openControl(): void {
  if (!props.device || !canControl.value) return;
  emit('control', props.device);
}

async function copyUdid(): Promise<void> {
  if (!props.device) return;
  const ok = await copyText(props.device.udid);
  if (ok) message.success('UDID 已复制');
  else message.error('复制失败');
}

function copySummary(): void {
  const device = props.device;
  if (!device) return;
  const lines = [
    `设备名称: ${device.name}`,
    `市场名称: ${device.marketName ?? '-'}`,
    `品牌: ${device.brand ?? '-'}`,
    `系统版本: ${osLabel.value ?? '-'}`,
    `SDK: ${device.sdk ?? '-'}`,
    `CPU: ${device.cpu ?? '-'}`,
    `核心数: ${coresLabel.value ?? '-'}`,
    `内存: ${formatMemory(device.memoryMb)}`,
    `分辨率: ${formatResolution(device.resolution)}`,
    `节点: ${agentName.value}`,
    `UDID: ${device.udid}`,
    `状态: ${statusMeta.value.label}`,
  ];
  void copyText(lines.join('\n')).then((ok) => {
    if (ok) message.success('设备信息已复制');
    else message.error('复制失败');
  });
}
</script>

<template>
  <n-drawer
    :show="show"
    :width="'min(1120px, 94vw)'"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content
      :title="title"
      closable
      :body-content-style="bodyStyle"
      :native-scrollbar="false"
    >
      <div v-if="device" class="detail-grid">
        <!-- 左：设备信息 -->
        <section class="col info">
          <n-descriptions :column="1" label-placement="left" bordered size="small">
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
        </section>

        <!-- 中：预览 -->
        <section class="col preview-col">
          <n-image
            v-if="device.thumbnailAt > 0"
            :src="thumbnailUrl(device)"
            object-fit="contain"
            :img-props="{ style: 'max-height: 100%; max-width: 100%; object-fit: contain' }"
            show-toolbar
          />
          <div v-else class="preview-empty">
            <n-icon :size="28"><PhonePortraitOutline /></n-icon>
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
            点击可放大 / 缩放 / 全屏
          </span>
        </section>

        <!-- 右：操作 -->
        <section class="col actions">
          <n-button type="primary" block :disabled="!canControl" @click="openControl">
            实时控制
          </n-button>
          <n-button block :disabled="!canControl" @click="fileShow = true">
            文件管理
          </n-button>
          <n-button block @click="copyUdid">复制 UDID</n-button>
          <n-button block @click="copySummary">复制全部信息</n-button>

          <div class="actions-divider" />

          <div class="action-meta">
            <span>节点</span>
            <strong>{{ agentName }}</strong>
          </div>
          <div class="action-meta">
            <span>状态</span>
            <n-tag size="tiny" :type="statusMeta.type" :bordered="false" round>
              {{ statusMeta.label }}
            </n-tag>
          </div>
        </section>
      </div>

      <DeviceFileBrowser
        v-model:show="fileShow"
        :device-id="device?.id ?? ''"
        :device-name="device?.name ?? ''"
      />
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.detail-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr) 200px;
  gap: 16px;
}

.col {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.col.info {
  overflow-y: auto;
}

.preview-col {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.preview-col :deep(.n-image) {
  max-width: 100%;
  max-height: 100%;
}

.preview-col :deep(.n-image img) {
  max-height: 100%;
  max-width: 100%;
  object-fit: contain;
  cursor: zoom-in;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: #52525b;
  font-size: 12px;
}

.preview-status {
  position: absolute;
  top: 10px;
  right: 10px;
}

.preview-tip {
  position: absolute;
  bottom: 8px;
  left: 10px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  pointer-events: none;
}

.actions-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.action-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}

.action-meta strong {
  font-weight: 500;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caps {
  display: flex;
  align-items: center;
  gap: 6px;
}

@media (max-width: 900px) {
  .detail-grid {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .preview-col {
    min-height: 240px;
  }
}
</style>