<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NEmpty, NIcon, NInput, useDialog, useMessage } from 'naive-ui';
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
const cpu = ref<string | 'all'>('all');
const cores = ref<number | 'all'>('all');
const memory = ref<number | 'all'>('all');

/** 固定候选，保证没有设备时也能看到完整筛选项。 */
const DEFAULT_VERSIONS = ['11', '12', '13', '14', '15', '16'];
const DEFAULT_CORES = [4, 6, 8, 10];
const DEFAULT_MEMORY = [4, 6, 8, 12, 16, 24];

const platformPresent = computed(
  () => new Set(devices.value.map((device) => device.platform)),
);
const statusPresent = computed(
  () => new Set(devices.value.map((device) => device.status)),
);

const versionPlatform = computed(() => {
  const map = new Map<string, Platform>();
  for (const device of devices.value) {
    if (!device.osVersion || map.has(device.osVersion)) continue;
    map.set(device.osVersion, device.platform);
  }
  return map;
});

/** 默认候选 + 设备里实际出现的版本，只有出现过的才可点。 */
const versionOptions = computed(() => {
  const values = new Set([...DEFAULT_VERSIONS, ...versionPlatform.value.keys()]);
  return [...values]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    .map((value) => ({
      value,
      label: `${versionPlatform.value.get(value) === 'ios' ? 'iOS' : 'Android'} ${value}`,
      enabled: versionPlatform.value.has(value),
    }));
});

const cpuPresent = computed(() => {
  const set = new Set<string>();
  for (const device of devices.value) {
    if (device.cpu) set.add(device.cpu);
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

const cpuOptions = computed(() =>
  [...cpuPresent.value]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    .map((value) => ({ value, label: value, enabled: true })),
);

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
      if (version.value !== 'all' && device.osVersion !== version.value) {
        return false;
      }
      if (cpu.value !== 'all' && device.cpu !== cpu.value) return false;
      if (cores.value !== 'all' && device.cpuCores !== cores.value) return false;
      if (memory.value !== 'all') {
        const gb = memoryGb(device.memoryMb);
        if (gb !== memory.value) return false;
      }
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
  if (version.value !== 'all' && !versionPlatform.value.has(version.value)) {
    version.value = 'all';
  }
  if (cpu.value !== 'all' && !cpuPresent.value.has(cpu.value)) {
    cpu.value = 'all';
  }
  if (cores.value !== 'all' && !coresPresent.value.has(cores.value)) {
    cores.value = 'all';
  }
  if (memory.value !== 'all' && !memoryPresent.value.has(memory.value)) {
    memory.value = 'all';
  }
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
  cpu.value = 'all';
  cores.value = 'all';
  memory.value = 'all';
}
</script>

<template>
  <div class="devices-page">
    <div class="filters">
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
        <span class="filter-label">状态:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: status === 'all' }"
            @click="status = 'all'"
          >
            全部
          </button>
          <button
            type="button"
            class="opt"
            :class="{ active: status === 'online' }"
            :disabled="!statusPresent.has('online')"
            @click="status = 'online'"
          >
            在线
          </button>
          <button
            type="button"
            class="opt"
            :class="{ active: status === 'offline' }"
            :disabled="!statusPresent.has('offline')"
            @click="status = 'offline'"
          >
            离线
          </button>
          <button
            type="button"
            class="opt"
            :class="{ active: status === 'unauthorized' }"
            :disabled="!statusPresent.has('unauthorized')"
            @click="status = 'unauthorized'"
          >
            未授权
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
        <span class="filter-label">CPU:</span>
        <div class="filter-options">
          <button
            type="button"
            class="opt"
            :class="{ active: cpu === 'all' }"
            @click="cpu = 'all'"
          >
            全部
          </button>
          <button
            v-for="option in cpuOptions"
            :key="option.value"
            type="button"
            class="opt"
            :class="{ active: cpu === option.value }"
            @click="cpu = option.value"
          >
            {{ option.label }}
          </button>
          <span v-if="cpuOptions.length === 0" class="empty-tip">
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

      <div class="filter-row">
        <span class="filter-label">操作:</span>
        <div class="filter-options">
          <button type="button" class="opt" @click="resetFilters">重置筛选</button>
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
        </div>
      </div>
    </div>

    <div v-if="filtered.length > 0" class="grid">
      <DeviceCard
        v-for="device in filtered"
        :key="device.id"
        :device="device"
        :agent-name="agentNames.get(device.agentId) ?? '未知节点'"
        @detail="openDetail"
        @control="openControl"
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