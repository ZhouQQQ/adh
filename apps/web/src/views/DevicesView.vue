<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  NButton,
  NCollapseTransition,
  NEmpty,
  NIcon,
  NInput,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import { SearchOutline } from '@vicons/ionicons5';
import type { DeviceStatus, DeviceSummary, Platform } from '@adh/protocol';
import DeviceCard from '../components/DeviceCard.vue';
import DeviceDetailDrawer from '../components/DeviceDetailDrawer.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
import { memoryGb } from '../utils/format';

const router = useRouter();
const { devices, agents, refresh } = useFleet();
const dialog = useDialog();
const message = useMessage();

const keyword = ref('');
const platform = ref<Platform | 'all'>('all');
const status = ref<DeviceStatus | 'all'>('all');
const version = ref<string | 'all'>('all');
const cpuVendor = ref<string | 'all'>('all');
const cpuModel = ref<string | 'all'>('all');
const cores = ref<number | 'all'>('all');
const memory = ref<number | 'all'>('all');
const usage = ref<'all' | 'idle' | 'busy'>('all');
const collapsed = ref(false);
const selectedIds = ref<string[]>([]);

/** 默认内置候选，配合设备实际值一起展示，没有设备命中的置灰。 */
const DEFAULT_ANDROID_VERSIONS = [
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
];
const DEFAULT_IOS_VERSIONS = ['15', '16', '17', '18', '26'];
const DEFAULT_CORES = [4, 6, 8, 10, 12];
const DEFAULT_MEMORY = [4, 6, 8, 12, 16, 24];
const DEFAULT_CPU_VENDORS = ['联发科', '高通', '华为', '三星', 'Google', '紫光展锐'];

/** 版本用 platform:version 作为值，避免 Android 14 与 iOS 14 冲突。 */
const versionOptions = computed(() => {
  const candidates = new Map<
    string,
    { platform: Platform; version: string }
  >();
  for (const value of DEFAULT_ANDROID_VERSIONS) {
    candidates.set(`android:${value}`, { platform: 'android', version: value });
  }
  for (const value of DEFAULT_IOS_VERSIONS) {
    candidates.set(`ios:${value}`, { platform: 'ios', version: value });
  }

  const present = new Set<string>();
  for (const device of devices.value) {
    if (!device.osVersion) continue;
    const key = `${device.platform}:${device.osVersion}`;
    present.add(key);
    if (!candidates.has(key)) {
      candidates.set(key, {
        platform: device.platform,
        version: device.osVersion,
      });
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => {
      if (a[1].platform !== b[1].platform) return a[1].platform === 'android' ? -1 : 1;
      return a[1].version.localeCompare(b[1].version, 'zh-CN', { numeric: true });
    })
    .map(([key, info]) => ({
      value: key,
      label: `${info.platform === 'ios' ? 'iOS' : 'Android'} ${info.version}`,
      enabled: present.has(key),
    }));
});

const platformPresent = computed(
  () => new Set(devices.value.map((device) => device.platform)),
);

const statusPresent = computed(
  () => new Set(devices.value.map((device) => device.status)),
);

const cpuVendorPresent = computed(() => {
  const set = new Set<string>();
  for (const device of devices.value) {
    if (device.cpuVendor) set.add(device.cpuVendor);
  }
  return set;
});

const cpuModelPresent = computed(() => {
  const set = new Set<string>();
  for (const device of devices.value) {
    if (device.cpuModel) set.add(device.cpuModel);
  }
  return set;
});

const coresPresent = computed(() => {
  const set = new Set<number>();
  for (const device of devices.value) {
    if (device.cpuCores) set.add(device.cpuCores);
  }
  return set;
});

const memoryPresent = computed(() => {
  const set = new Set<number>();
  for (const device of devices.value) {
    const gb = memoryGb(device.memoryMb);
    if (gb !== undefined) set.add(gb);
  }
  return set;
});

const usagePresent = computed(() => ({
  busy: devices.value.some((device) => device.inUse),
  idle: devices.value.some((device) => !device.inUse),
}));

const cpuVendorOptions = computed(() => {
  const values = new Set([...DEFAULT_CPU_VENDORS, ...cpuVendorPresent.value]);
  return [...values]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((value) => ({
      value,
      label: value,
      enabled: cpuVendorPresent.value.has(value),
    }));
});

/** 型号跟着品牌联动；型号数量太多，只列实际出现的。 */
const cpuModelOptions = computed(() => {
  const set = new Set<string>();
  for (const device of devices.value) {
    if (!device.cpuModel) continue;
    if (cpuVendor.value !== 'all' && device.cpuVendor !== cpuVendor.value) {
      continue;
    }
    set.add(device.cpuModel);
  }
  return [...set]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    .map((value) => ({ value, label: value }));
});

const coresOptions = computed(() => {
  const values = new Set([...DEFAULT_CORES, ...coresPresent.value]);
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      label: `${value} 核`,
      enabled: coresPresent.value.has(value),
    }));
});

const memoryOptions = computed(() => {
  const values = new Set([...DEFAULT_MEMORY, ...memoryPresent.value]);
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      label: `${value} GB`,
      enabled: memoryPresent.value.has(value),
    }));
});

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return devices.value
    .filter((device) => {
      if (platform.value !== 'all' && device.platform !== platform.value) {
        return false;
      }
      if (status.value !== 'all' && device.status !== status.value) return false;
      if (version.value !== 'all') {
        const key = `${device.platform}:${device.osVersion ?? ''}`;
        if (key !== version.value) return false;
      }
      if (cpuVendor.value !== 'all' && device.cpuVendor !== cpuVendor.value) {
        return false;
      }
      if (cpuModel.value !== 'all' && device.cpuModel !== cpuModel.value) {
        return false;
      }
      if (cores.value !== 'all' && device.cpuCores !== cores.value) return false;
      if (memory.value !== 'all') {
        const gb = memoryGb(device.memoryMb);
        if (gb !== memory.value) return false;
      }
      if (usage.value === 'busy' && !device.inUse) return false;
      if (usage.value === 'idle' && device.inUse) return false;
      if (kw) {
        const haystack = [
          device.name,
          device.marketName,
          device.model,
          device.brand,
          device.udid,
          device.cpu,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const rank = (value: DeviceStatus) =>
        value === 'online' ? 0 : value === 'unauthorized' ? 1 : 2;
      const diff = rank(a.status) - rank(b.status);
      return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
    });
});

const agentNames = computed(
  () => new Map(agents.value.map((agent) => [agent.id, agent.name])),
);

const STATUS_LABEL: Record<DeviceStatus, string> = {
  online: '在线',
  offline: '离线',
  unauthorized: '未授权',
};

/** 折叠后显示的已选条件摘要，可单独移除。 */
const activeFilters = computed(() => {
  const list: { key: string; label: string }[] = [];

  if (keyword.value.trim()) {
    list.push({ key: 'keyword', label: `关键字: ${keyword.value.trim()}` });
  }
  if (platform.value !== 'all') {
    list.push({
      key: 'platform',
      label: platform.value === 'android' ? 'Android' : 'iOS',
    });
  }
  if (status.value !== 'all') {
    list.push({ key: 'status', label: STATUS_LABEL[status.value] });
  }
  if (version.value !== 'all') {
    const option = versionOptions.value.find((item) => item.value === version.value);
    list.push({ key: 'version', label: option?.label ?? version.value });
  }
  if (cpuVendor.value !== 'all') {
    list.push({ key: 'cpuVendor', label: cpuVendor.value });
  }
  if (cpuModel.value !== 'all') {
    list.push({ key: 'cpuModel', label: cpuModel.value });
  }
  if (cores.value !== 'all') {
    list.push({ key: 'cores', label: `${cores.value} 核` });
  }
  if (memory.value !== 'all') {
    list.push({ key: 'memory', label: `${memory.value} GB` });
  }
  if (usage.value !== 'all') {
    list.push({ key: 'usage', label: usage.value === 'busy' ? '使用中' : '空闲' });
  }

  return list;
});

function removeFilter(key: string): void {
  switch (key) {
    case 'keyword':
      keyword.value = '';
      break;
    case 'platform':
      platform.value = 'all';
      break;
    case 'status':
      status.value = 'all';
      break;
    case 'version':
      version.value = 'all';
      break;
    case 'cpuVendor':
      cpuVendor.value = 'all';
      break;
    case 'cpuModel':
      cpuModel.value = 'all';
      break;
    case 'cores':
      cores.value = 'all';
      break;
    case 'memory':
      memory.value = 'all';
      break;
    case 'usage':
      usage.value = 'all';
      break;
  }
}

const offlineCount = computed(
  () => devices.value.filter((device) => device.status === 'offline').length,
);

/** 选中的选项被拔掉后自动回到「全部」，避免筛选结果永远是空。 */
watch(devices, () => {
  if (platform.value !== 'all' && !platformPresent.value.has(platform.value)) {
    platform.value = 'all';
  }
  if (status.value !== 'all' && !statusPresent.value.has(status.value)) {
    status.value = 'all';
  }
  if (version.value !== 'all') {
    const hasDevice = devices.value.some(
      (device) => `${device.platform}:${device.osVersion ?? ''}` === version.value,
    );
    if (!hasDevice) version.value = 'all';
  }
  if (cpuVendor.value !== 'all' && !cpuVendorPresent.value.has(cpuVendor.value)) {
    cpuVendor.value = 'all';
  }
  if (cpuModel.value !== 'all' && !cpuModelPresent.value.has(cpuModel.value)) {
    cpuModel.value = 'all';
  }
  if (cores.value !== 'all' && !coresPresent.value.has(cores.value)) {
    cores.value = 'all';
  }
  if (memory.value !== 'all' && !memoryPresent.value.has(memory.value)) {
    memory.value = 'all';
  }
});

watch(cpuVendor, () => {
  cpuModel.value = 'all';
});

const selectedId = ref<string | null>(null);
const detailShow = ref(false);

const selectedDevice = computed<DeviceSummary | null>(
  () => devices.value.find((device) => device.id === selectedId.value) ?? null,
);

function openDetail(device: DeviceSummary): void {
  selectedId.value = device.id;
  detailShow.value = true;
}

function openControl(device: DeviceSummary): void {
  detailShow.value = false;
  void router.push(`/devices/${device.id}/control`);
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id];
}

function clearSelection(): void {
  selectedIds.value = [];
}

function batchControl(): void {
  if (selectedIds.value.length === 0) return;
  void router.push(`/devices/batch?ids=${selectedIds.value.join(',')}`);
}

function cleanupOffline(): void {
  if (offlineCount.value === 0) return;
  dialog.warning({
    title: '清理离线设备',
    content: `将移除 ${offlineCount.value} 台离线设备记录。设备重新接入后会自动再次出现。`,
    positiveText: '清理',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await api.cleanupOfflineDevices();
        message.success(`已清理 ${result.removed} 台离线设备`);
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '清理失败');
      }
    },
  });
}

function resetFilters(): void {
  keyword.value = '';
  platform.value = 'all';
  status.value = 'all';
  version.value = 'all';
  cpuVendor.value = 'all';
  cpuModel.value = 'all';
  cores.value = 'all';
  memory.value = 'all';
  usage.value = 'all';
}
</script>

<template>
  <div class="devices-page">
    <div class="filters">
      <div class="filter-header">
        <span class="filter-title">筛选</span>
        <div class="active-filters">
          <template v-if="activeFilters.length > 0">
            <n-tag
              v-for="item in activeFilters"
              :key="item.key"
              size="small"
              :bordered="false"
              closable
              @close="removeFilter(item.key)"
            >
              {{ item.label }}
            </n-tag>
          </template>
          <span v-else class="filter-hint">全部设备</span>
        </div>

        <div class="header-actions">
          <button type="button" class="opt" @click="resetFilters">重置</button>
          <button
            type="button"
            class="opt"
            :disabled="offlineCount === 0"
            @click="cleanupOffline"
          >
            清理离线{{ offlineCount > 0 ? ` (${offlineCount})` : '' }}
          </button>
          <button type="button" class="opt" @click="refresh">刷新</button>
          <span class="result-count">
            {{ filtered.length }} / {{ devices.length }}
          </span>
          <button
            type="button"
            class="opt toggle"
            @click="collapsed = !collapsed"
          >
            {{ collapsed ? '展开' : '收起' }}
          </button>
        </div>
      </div>

      <n-collapse-transition :show="!collapsed">
        <div class="filter-body">
      <div class="filter-row">
        <span class="filter-label">关键字:</span>
        <div class="filter-options">
          <n-input
            v-model:value="keyword"
            size="small"
            placeholder="名称 / 型号 / CPU / UDID"
            clearable
            style="width: 260px"
          >
            <template #prefix>
              <n-icon :component="SearchOutline" />
            </template>
          </n-input>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">类型:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: platform === 'all' }"
            @click="platform = 'all'"
          >
            全部
          </button>
          <button
            type="button"
            class="opt"
            :class="{ active: platform === 'android' }"
            :disabled="!platformPresent.has('android')"
            @click="platform = 'android'"
          >
            Android
          </button>
          <button
            type="button"
            class="opt"
            :class="{ active: platform === 'ios' }"
            :disabled="!platformPresent.has('ios')"
            @click="platform = 'ios'"
          >
            iOS
          </button>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">系统版本:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: version === 'all' }"
            @click="version = 'all'"
          >
            全部
          </button>
          <button
            v-for="option in versionOptions"
            :key="option.value"
            type="button"
            class="opt"
            :class="{ active: version === option.value }"
            :disabled="!option.enabled"
            @click="version = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">CPU 品牌:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: cpuVendor === 'all' }"
            @click="cpuVendor = 'all'"
          >
            全部
          </button>
          <button
            v-for="option in cpuVendorOptions"
            :key="option.value"
            type="button"
            class="opt"
            :class="{ active: cpuVendor === option.value }"
            :disabled="!option.enabled"
            @click="cpuVendor = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">CPU 型号:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: cpuModel === 'all' }"
            @click="cpuModel = 'all'"
          >
            全部
          </button>
          <button
            v-for="option in cpuModelOptions"
            :key="option.value"
            type="button"
            class="opt"
            :class="{ active: cpuModel === option.value }"
            @click="cpuModel = option.value"
          >
            {{ option.label }}
          </button>
          <span v-if="cpuModelOptions.length === 0" class="empty-tip">
            暂无数据
          </span>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">核心数:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: cores === 'all' }"
            @click="cores = 'all'"
          >
            全部
          </button>
          <button
            v-for="option in coresOptions"
            :key="option.value"
            type="button"
            class="opt"
            :class="{ active: cores === option.value }"
            :disabled="!option.enabled"
            @click="cores = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">内存:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: memory === 'all' }"
            @click="memory = 'all'"
          >
            全部
          </button>
          <button
            v-for="option in memoryOptions"
            :key="option.value"
            type="button"
            class="opt"
            :class="{ active: memory === option.value }"
            :disabled="!option.enabled"
            @click="memory = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
        </div>
      </n-collapse-transition>
    </div>

    <div v-if="filtered.length > 0" class="grid">
      <DeviceCard
        v-for="device in filtered"
        :key="device.id"
        :device="device"
        :agent-name="agentNames.get(device.agentId) ?? '未知节点'"
        :selectable="true"
        :selected="selectedIds.includes(device.id)"
        @detail="openDetail"
        @control="openControl"
        @select="toggleSelect"
      />
    </div>

    <n-empty
      v-else
      class="empty"
      :description="devices.length === 0 ? '暂无设备接入' : '没有匹配的设备'"
    >
      <template #extra>
        <p v-if="devices.length === 0" class="empty-hint">
          用 USB 连接 Android 设备并开启「USB 调试」，节点会在 5 秒内自动发现。
          若显示「未授权」，请在手机上确认调试授权弹窗。
        </p>
        <n-button v-else size="small" @click="resetFilters">清空筛选条件</n-button>
      </template>
    </n-empty>

    <div v-if="selectedIds.length > 0" class="selection-bar">
      <span class="selection-text">已选 {{ selectedIds.length }} 台设备</span>
      <button type="button" class="selection-btn" @click="clearSelection">
        取消选择
      </button>
      <button type="button" class="selection-btn primary" @click="batchControl">
        批量控制
      </button>
    </div>

    <DeviceDetailDrawer
      v-model:show="detailShow"
      :device="selectedDevice"
      @control="openControl"
    />
  </div>
</template>

<style scoped>
.devices-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.filters {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 2px 16px;
}

.filter-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.filter-title {
  flex: none;
  font-size: 12px;
  color: var(--text-dim);
}

.active-filters {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.filter-hint {
  font-size: 12px;
  color: var(--text-faint);
}

.header-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

.toggle {
  flex: none;
  font-size: 12px;
  color: var(--text-dim);
}

.filter-body {
  border-top: 1px dashed var(--border);
}

.filter-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 9px 0;
}

.filter-row + .filter-row {
  border-top: 1px dashed var(--border);
}

.filter-label {
  flex: none;
  width: 78px;
  padding-top: 3px;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}

.filter-options {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

.opt {
  padding: 2px 9px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.opt:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}

.opt:disabled {
  color: #d4d4d8;
  cursor: not-allowed;
  pointer-events: none;
}

.opt.active {
  background: #18181b;
  color: #fafafa;
}

.opt.active:hover {
  background: #27272a;
}

.empty-tip {
  padding: 2px 0;
  font-size: 12px;
  color: var(--text-faint);
}

.result-count {
  margin-left: auto;
  padding-right: 2px;
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.empty {
  padding: 48px 0;
}

.empty-hint {
  margin: 0;
  max-width: 460px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

.selection-bar {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px 9px 16px;
  border-radius: 10px;
  background: #18181b;
  box-shadow: 0 10px 30px rgba(9, 9, 11, 0.24);
  z-index: 20;
}

.selection-text {
  font-size: 12px;
  color: #e4e4e7;
}

.selection-btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: #d4d4d8;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.selection-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.selection-btn.primary {
  background: #fafafa;
  border-color: #fafafa;
  color: #09090b;
  font-weight: 500;
}

.selection-btn.primary:hover {
  background: #e4e4e7;
}

@media (max-width: 720px) {
  .filter-row {
    flex-direction: column;
    gap: 4px;
  }

  .filter-label {
    width: auto;
  }
}
</style>