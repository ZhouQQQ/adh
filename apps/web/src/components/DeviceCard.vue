<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NDropdown,
  NIcon,
  NTag,
  useMessage,
  type DropdownOption,
} from 'naive-ui';
import { LogoAndroid, LogoApple } from '@vicons/ionicons5';
import {
  EllipsisVerticalOutline,
  FingerPrintOutline,
  HardwareChipOutline,
  LockClosedOutline,
  LockOpenOutline,
  PersonOutline,
  PhonePortraitOutline,
  PlayCircleOutline,
  ResizeOutline,
  SparklesOutline,
  SpeedometerOutline,
  WifiOutline,
} from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import DeviceBattery from './DeviceBattery.vue';
import { api } from '../api';
import { useAuth } from '../stores/auth';
import { BRAND_META, deviceBrand } from '../utils/brand';
import {
  formatMemory,
  formatAgo,
  formatDuration,
  formatResolution,
} from '../utils/format';

const props = defineProps<{
  device: DeviceSummary;
  agentName: string;
  selectable?: boolean;
  selected?: boolean;
}>();

const emit = defineEmits<{
  detail: [device: DeviceSummary];
  control: [device: DeviceSummary];
  select: [id: string];
  kick: [device: DeviceSummary];
  lock: [device: DeviceSummary];
  refresh: [];
}>();

const { user, isAdmin } = useAuth();
const message = useMessage();
const now = ref(Date.now());
const wdaBusy = ref(false);

/** 卡片右上角三点菜单：锁定 / 解锁，iOS 额外提供启动 XCTest + 转发。 */
const moreOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [
    {
      label: props.device.locked ? '解除锁定' : '锁定设备',
      key: 'lock',
      icon: () =>
        h(NIcon, null, {
          default: () =>
            h(props.device.locked ? LockOpenOutline : LockClosedOutline),
        }),
    },
  ];

  if (props.device.platform === 'ios') {
    const wdaReady = props.device.capabilities?.includes('wda');
    // 每台 iOS 设备各自一个本地端口，多台设备接同一节点时不会互相覆盖
    const port = props.device.wdaPort;
    options.push({
      label: wdaBusy.value
        ? '正在启动 XCTest…'
        : `${wdaReady ? '重启' : '启动'} XCTest + 转发${port ? `（:${port}）` : ''}`,
      key: 'start-wda',
      disabled: wdaBusy.value,
      icon: () => h(NIcon, null, { default: () => h(PlayCircleOutline) }),
    });
  }

  return options;
});

async function onMoreSelect(key: string): Promise<void> {
  if (key === 'lock') {
    emit('lock', props.device);
    return;
  }
  if (key !== 'start-wda') return;
  if (wdaBusy.value) return;

  wdaBusy.value = true;
  const loading = message.loading('正在启动 XCTest 并建立端口转发…', {
    duration: 0,
  });
  try {
    // 已经是 WDA 就绪状态时，这个按钮的语义是「重启」：先停掉旧实例再拉起，
    // 不能因为端口还能响应就直接返回。
    const restart = props.device.capabilities?.includes('wda') ?? false;
    const result = await api.startIosWda(props.device.id, restart);
    message.success(result.message || '操作完成');
    emit('refresh');
  } catch (error) {
    message.error(
      error instanceof Error ? error.message : '操作失败',
    );
  } finally {
    loading.destroy();
    wdaBusy.value = false;
  }
}

const controlName = computed(() =>
  props.device.control
    ? props.device.control.displayName || props.device.control.username
    : '',
);

const aiTaskName = computed(() =>
  props.device.aiTask
    ? props.device.aiTask.displayName || props.device.aiTask.username
    : '',
);

/** 品牌 logo：小米 / 华为 / 荣耀 / OPPO / vivo / 苹果。 */
const brandMeta = computed(() => {
  const key = deviceBrand(props.device);
  return key ? BRAND_META[key] : null;
});

/** 卡片状态色：红=锁定，蓝=我在用，黄=别人在用，紫=AI 任务执行中。 */
const usageTone = computed(() => {
  if (props.device.locked) return 'locked';
  if (props.device.aiTask) return 'ai';
  const control = props.device.control;
  if (!control) return '';
  return control.userId === user.value?.id ? 'mine' : 'busy';
});
const controlDuration = computed(() =>
  props.device.control
    ? formatDuration(props.device.control.since, now.value)
    : '',
);
const aiTaskDuration = computed(() =>
  props.device.aiTask
    ? formatDuration(props.device.aiTask.since, now.value)
    : '',
);
const canKick = computed(
  () =>
    isAdmin.value &&
    Boolean(props.device.control) &&
    props.device.control?.userId !== user.value?.id,
);

/** 别人正在控制时按钮显示「查看」，自己在控制时显示「继续控制」。 */
const controlLabel = computed(() => {
  if (props.device.locked) return '已锁定';
  if (props.device.aiTask) return 'AI 任务中';
  const control = props.device.control;
  if (!control) return '控制';
  return control.userId === user.value?.id ? '继续控制' : '查看';
});

let clockTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
});

const statusMeta = computed(() => {
  switch (props.device.status) {
    case 'online':
      return { type: 'success' as const, label: '在线' };
    case 'unauthorized':
      return { type: 'warning' as const, label: '未授权' };
    default:
      return { type: 'default' as const, label: '离线' };
  }
});

/** 标题优先显示机型市场名（如 iPhone 16 Pro），回退到设备名。 */
const titleText = computed(
  () => props.device.marketName || props.device.name,
);

const subtitle = computed(
  () =>
    props.device.brand ||
    (props.device.platform === 'ios' ? 'Apple' : '未知品牌'),
);

const osText = computed(() => {
  const device = props.device;
  if (!device.osVersion) return '—';
  return device.platform === 'ios'
    ? `iOS ${device.osVersion}`
    : `Android ${device.osVersion}`;
});

const memoryText = computed(() => formatMemory(props.device.memoryMb));

const resolutionText = computed(() =>
  formatResolution(props.device.resolution),
);

/** Android 在线即可控制；iOS 需要 WDA 已就绪。锁定后任何人都不能进。 */
const canControl = computed(
  () =>
    !props.device.locked &&
    !props.device.aiTask &&
    props.device.status === 'online' &&
    (props.device.platform === 'android' ||
      props.device.capabilities.includes('wda')),
);

const network = ref<{
  connected: boolean;
  ssid: string | null;
  ip: string | null;
} | null>(null);
let networkTimer: ReturnType<typeof setInterval> | null = null;

async function loadNetwork(): Promise<void> {
  if (props.device.status !== 'online') {
    network.value = null;
    return;
  }
  try {
    network.value = await api.deviceNetwork(props.device.id);
  } catch {
    network.value = null;
  }
}

function startNetwork(): void {
  stopNetwork();
  void loadNetwork();
  networkTimer = setInterval(() => void loadNetwork(), 30_000);
}

function stopNetwork(): void {
  if (networkTimer) clearInterval(networkTimer);
  networkTimer = null;
}

onMounted(startNetwork);
onBeforeUnmount(stopNetwork);
watch(() => [props.device.id, props.device.status] as const, startNetwork);

const cpuText = computed(() => {
  const device = props.device;
  const parts: string[] = [];
  if (device.cpu) parts.push(device.cpu);
  if (device.cpuCores) parts.push(`${device.cpuCores} 核`);
  return parts.join(' · ') || '—';
});

/** 卡片上优先显示 WiFi 名称，IP 放在悬浮提示里。 */
const wifiText = computed(() => {
  const net = network.value;
  if (!net) return '—';
  if (!net.connected) return '未连接';
  return net.ssid ?? (net.ip ? '已连接' : '—');
});

const wifiTitle = computed(() => {
  const net = network.value;
  if (!net) return 'WiFi';
  if (!net.connected) return 'WiFi 未连接';
  return [net.ssid ?? 'WiFi', net.ip].filter(Boolean).join(' · ');
});
</script>

<template>
  <article
    class="device-card"
    :class="{ offline: device.status !== 'online', selected }"
  >
    <span v-if="usageTone" class="tone-bar" :class="usageTone" />
    <div class="thumb">
      <button
        v-if="selectable"
        type="button"
        class="select-toggle"
        :class="{ checked: selected }"
        :title="selected ? '取消选择' : '选择'"
        @click.stop="emit('select', device.id)"
      >
        <span v-if="selected" class="check">✓</span>
      </button>

      <div class="placeholder" :class="device.platform">
        <img
          v-if="brandMeta"
          :src="brandMeta.logo"
          :alt="brandMeta.label"
          class="brand-logo"
        />
        <n-icon v-else :size="48">
          <LogoAndroid v-if="device.platform === 'android'" />
          <LogoApple v-else />
        </n-icon>
      </div>

      <div
        v-if="device.aiTask"
        class="control-tag ai-task"
        :class="{ shifted: selectable }"
        :title="`${aiTaskName} 的 AI 任务正在执行`"
      >
        <n-icon :size="12"><SparklesOutline /></n-icon>
        <span class="control-name">AI 任务 · {{ aiTaskName }}</span>
        <span class="control-time">已执行 {{ aiTaskDuration }}</span>
      </div>
      <div
        v-else-if="device.control"
        class="control-tag"
        :class="[usageTone, { shifted: selectable }]"
        :title="`${controlName} 正在控制`"
      >
        <n-icon :size="12"><PersonOutline /></n-icon>
        <span class="control-name">{{ controlName }}</span>
        <span class="control-time">已使用 {{ controlDuration }}</span>
      </div>
      <div class="battery-tag">
        <DeviceBattery
          :device-id="device.id"
          :online="device.status === 'online'"
        />
      </div>

      <div
        v-if="device.status === 'offline'"
        class="offline-tag"
        :class="{ shifted: selectable }"
      >
        最后在线 {{ formatAgo(device.lastSeen) }}
      </div>

      <div class="thumb-badges">
        <n-tag
          class="status-tag"
          size="small"
          :type="statusMeta.type"
          :bordered="false"
          round
        >
          {{ statusMeta.label }}
        </n-tag>
        <n-tag
          v-if="device.locked"
          size="small"
          type="error"
          :bordered="false"
          round
        >
          已锁定
        </n-tag>
      </div>
    </div>

    <div class="body">
      <div class="title" :title="titleText">{{ titleText }}</div>
      <div class="subtitle">{{ subtitle }}</div>

      <div class="kv-grid">
        <div class="kv">
          <n-icon class="k" :size="12" title="系统版本">
            <PhonePortraitOutline />
          </n-icon>
          <span class="v">{{ osText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="分辨率">
            <ResizeOutline />
          </n-icon>
          <span class="v">{{ resolutionText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="CPU">
            <HardwareChipOutline />
          </n-icon>
          <span class="v" :title="cpuText">{{ cpuText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="内存">
            <SpeedometerOutline />
          </n-icon>
          <span class="v">{{ memoryText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="IP 地址">
            <WifiOutline />
          </n-icon>
          <span class="v mono">{{ network?.ip ?? '—' }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="WiFi 名称">
            <WifiOutline />
          </n-icon>
          <span class="v" :title="wifiTitle">{{ wifiText }}</span>
        </div>
        <div class="kv span-2">
          <n-icon class="k" :size="12" title="UDID">
            <FingerPrintOutline />
          </n-icon>
          <span class="v mono" :title="device.udid">{{ device.udid }}</span>
        </div>
      </div>

      </div>

    <div class="actions">
      <n-button size="tiny" quaternary @click="emit('detail', device)">
        详情
      </n-button>
      <n-button
        size="tiny"
        type="primary"
        secondary
        :disabled="!canControl"
        @click="emit('control', device)"
      >
        {{ controlLabel }}
      </n-button>
      <n-button
        v-if="canKick"
        size="tiny"
        type="error"
        quaternary
        @click="emit('kick', device)"
      >
        断开
      </n-button>
      <n-dropdown
        v-if="isAdmin"
        trigger="click"
        placement="bottom-end"
        :options="moreOptions"
        @select="onMoreSelect"
      >
        <n-button class="more-btn" size="tiny" tertiary title="更多操作">
          <template #icon>
            <n-icon><EllipsisVerticalOutline /></n-icon>
          </template>
        </n-button>
      </n-dropdown>
    </div>
  </article>
</template>

<style scoped>
.device-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  overflow: hidden;
  /* 极轻的阴影，避免白底白卡时下边框看不出来 */
  box-shadow: 0 1px 2px rgba(9, 9, 11, 0.04);
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.device-card:hover {
  border-color: var(--text-faint);
  background: #fcfcfd;
}

/* 状态用顶部细色条表示，不再给整圈边框上色 */
.tone-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 3;
}

.tone-bar.locked {
  background: #ef4444;
}

.tone-bar.mine {
  background: #3b82f6;
}

.tone-bar.busy {
  background: #f59e0b;
}

.tone-bar.ai {
  background: #8b5cf6;
}

.device-card.offline {
  opacity: 0.65;
}

.thumb {
  position: relative;
  height: 170px;
  background: linear-gradient(180deg, #fafafa 0%, #f4f4f5 100%);
  display: grid;
  place-items: center;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--border-strong);
}

.placeholder.android {
  color: #34a853;
  opacity: 0.85;
}

.placeholder.ios {
  color: #18181b;
  opacity: 0.8;
}

/* 品牌 logo：放在缩略图中央，覆盖 .thumb img 的 100% 规则 */
.placeholder .brand-logo {
  width: 68px;
  height: 68px;
  object-fit: contain;
  opacity: 0.92;
}

.thumb-badges {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 2;
}

.status-tag {
  backdrop-filter: blur(6px);
}

.battery-tag {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
}

.control-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 190px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid #e4e4e7;
  color: #27272a;
  font-size: 11px;
  line-height: 1.25;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(9, 9, 11, 0.12);
}

/* 左侧圆点表示状态：蓝=我在用，黄=别人在用 */
.control-tag::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a1a1aa;
}

.control-tag.mine::before {
  background: #3b82f6;
}

.control-tag.busy::before {
  background: #f59e0b;
}

.control-tag.ai-task::before {
  display: none;
}

.control-tag.ai-task {
  border-color: #ddd6fe;
  color: #5b21b6;
}

.control-tag.ai-task .control-name {
  max-width: 110px;
}

/* 有勾选框时让开一点，贴着勾选框显示 */
.control-tag.shifted {
  left: 34px;
}

.control-name {
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-time {
  color: #52525b;
  white-space: nowrap;
}

.select-toggle {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.92);
  color: #ffffff;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;
}

.select-toggle.checked {
  background: #18181b;
  border-color: #18181b;
}

.check {
  font-size: 11px;
  line-height: 1;
}

.device-card.selected {
  border-color: #18181b;
  box-shadow: 0 0 0 1px #18181b;
}

.body {
  padding: 15px 17px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.title {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subtitle {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.kv {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11.5px;
}

.kv.span-2 {
  grid-column: span 2;
}

.k {
  flex: none;
  color: var(--text-faint);
}

.v {
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.v.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.offline-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 251, 235, 0.9);
  color: #b45309;
  font-size: 10px;
  white-space: nowrap;
  backdrop-filter: blur(6px);
}

/* 批量选择时让开左上角的勾选框 */
.offline-tag.shifted {
  left: 34px;
}

.actions {
  display: flex;
  gap: 6px;
  padding: 0 12px 12px;
}

.actions :deep(.n-button) {
  flex: 1;
}

.actions :deep(.more-btn) {
  flex: none;
  width: 28px;
}
</style>