<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NIcon } from 'naive-ui';
import {
  BatteryChargingOutline,
  BatteryHalfOutline,
  ServerOutline,
  SpeedometerOutline,
  WifiOutline,
} from '@vicons/ionicons5';
import { api, type DeviceRuntime } from '../api';

const props = defineProps<{ deviceId: string }>();

const stats = ref<DeviceRuntime | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const POLL_MS = 10_000;

function batteryColor(level: number | null, charging: boolean): string {
  if (charging) return '#22c55e';
  if (level === null) return '#a1a1aa';
  if (level <= 20) return '#ef4444';
  if (level <= 50) return '#f59e0b';
  return '#22c55e';
}

function formatGb(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function percentOf(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (used === null || used === undefined || !total) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

const metrics = computed(() => {
  const current = stats.value;
  if (!current) return [];

  const memoryPercent = percentOf(
    current.memory?.usedMb,
    current.memory?.totalMb,
  );
  const storagePercent = percentOf(
    current.storage?.usedMb,
    current.storage?.totalMb,
  );

  return [
    {
      key: 'battery',
      icon: current.battery.charging ? BatteryChargingOutline : BatteryHalfOutline,
      label: '电量',
      hint: current.battery.charging ? '充电中' : '未充电',
      percent: current.battery.level,
      text: current.battery.level === null ? '—' : `${current.battery.level}%`,
      color: batteryColor(current.battery.level, current.battery.charging),
    },
    {
      key: 'memory',
      icon: SpeedometerOutline,
      label: '内存',
      hint: current.memory
        ? current.memory.usedMb === null
          ? `${formatGb(current.memory.totalMb)} 总量`
          : `${formatGb(current.memory.usedMb)} / ${formatGb(current.memory.totalMb)}`
        : '—',
      percent: memoryPercent,
      text: memoryPercent === null ? '—' : `${memoryPercent}%`,
      color: '#3b82f6',
    },
    {
      key: 'storage',
      icon: ServerOutline,
      label: '存储',
      hint: current.storage
        ? `${formatGb(current.storage.usedMb)} / ${formatGb(current.storage.totalMb)}`
        : '—',
      percent: storagePercent,
      text: storagePercent === null ? '—' : `${storagePercent}%`,
      color: storagePercent !== null && storagePercent >= 90 ? '#ef4444' : '#8b5cf6',
    },
  ];
});

const wifiText = computed(() => {
  const wifi = stats.value?.wifi;
  if (!wifi) return '不可用';
  if (!wifi.connected) return wifi.enabled ? '未连接' : '已关闭';

  const ssid = wifi.ssid ?? 'SSID 不可获取';
  return wifi.ip ? `${ssid} · ${wifi.ip}` : ssid;
});

async function load(): Promise<void> {
  if (!props.deviceId) return;
  try {
    stats.value = await api.getDeviceRuntime(props.deviceId);
  } catch {
    // 远程节点或设备离线时拿不到运行状态，整块隐藏
    stats.value = null;
  }
}

function start(): void {
  stop();
  void load();
  timer = setInterval(() => void load(), POLL_MS);
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

onMounted(start);
onBeforeUnmount(stop);
watch(() => props.deviceId, start);
</script>

<template>
  <div v-if="stats" class="stats">
    <div v-for="metric in metrics" :key="metric.key" class="stat">
      <span class="stat-icon">
        <n-icon :size="15"><component :is="metric.icon" /></n-icon>
      </span>
      <div class="stat-text">
        <span class="stat-label">{{ metric.label }}</span>
        <span class="stat-hint">{{ metric.hint }}</span>
      </div>
      <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="ring-track" cx="18" cy="18" r="15.5" />
        <circle
          class="ring-value"
          cx="18"
          cy="18"
          r="15.5"
          pathLength="100"
          :stroke="metric.color"
          :stroke-dasharray="`${metric.percent ?? 0} 100`"
        />
        <text class="ring-text" x="18" y="18">{{ metric.text }}</text>
      </svg>
    </div>

    <div class="stat wifi">
      <span class="stat-icon">
        <n-icon :size="15"><WifiOutline /></n-icon>
      </span>
      <div class="stat-text">
        <span class="stat-label">WiFi</span>
        <span class="stat-hint" :title="wifiText">{{ wifiText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 380px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.stat-icon {
  flex: none;
  display: flex;
  align-items: center;
  color: var(--text-faint);
}

.stat-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.stat-label {
  font-size: 11px;
  color: var(--text-dim);
}

.stat-hint {
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ring {
  flex: none;
  width: 36px;
  height: 36px;
  transform: rotate(-90deg);
}

.ring-track {
  fill: none;
  stroke: #ececef;
  stroke-width: 4;
}

.ring-value {
  fill: none;
  stroke-width: 4;
  stroke-linecap: round;
  transition: stroke-dasharray 0.3s ease;
}

.ring-text {
  fill: var(--text-dim);
  font-size: 8.5px;
  font-weight: 600;
  text-anchor: middle;
  dominant-baseline: central;
  transform: rotate(90deg);
  transform-origin: 18px 18px;
}
</style>