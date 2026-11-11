<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, type DeviceRuntime } from '../api';

const props = defineProps<{ deviceId: string; online: boolean }>();

const battery = ref<DeviceRuntime['battery'] | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  if (!props.online || !props.deviceId) {
    battery.value = null;
    return;
  }
  try {
    battery.value = (await api.getDeviceBattery(props.deviceId)).battery;
  } catch {
    // 远程节点或设备离线时拿不到电量，直接隐藏
    battery.value = null;
  }
}

function start(): void {
  stop();
  void load();
  timer = setInterval(() => void load(), 30_000);
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

onMounted(start);
onBeforeUnmount(stop);
watch(() => [props.deviceId, props.online] as const, start);

const level = computed(() => battery.value?.level ?? null);
const charging = computed(() => battery.value?.charging ?? false);
const temperature = computed(() => battery.value?.temperature ?? null);
const temperatureText = computed(() =>
  temperature.value === null
    ? ''
    : `${Number(temperature.value.toFixed(1))}°C`,
);

const tone = computed(() => {
  const value = level.value ?? 0;
  if (value <= 20) return 'low';
  if (value <= 50) return 'mid';
  return 'high';
});

const fillRatio = computed(() => {
  const value = Math.min(100, Math.max(0, level.value ?? 0));
  return value / 100;
});
</script>

<template>
  <span
    v-if="level !== null"
    class="battery"
    :class="tone"
    :title="
      `${charging ? '充电中' : '电量'} · ${level}%${temperatureText ? ` · 电池 ${temperatureText}` : ''}`
    "
  >
    <span class="icon">
      <span class="shell">
        <span class="fill" :style="{ transform: `scaleX(${fillRatio})` }" />
        <span class="value">{{ level }}%</span>
      </span>
      <span class="nub" />
    </span>
  </span>
</template>

<style scoped>
.battery {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  line-height: 1;
  white-space: nowrap;
  flex: none;
}

.battery.low {
  --tone: #ff3b30;
}

.battery.mid {
  --tone: #ff9f0a;
}

.battery.high {
  --tone: #34c759;
}

/* 苹果风格：圆角电池外框 + 右侧小正极 */
.icon {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.shell {
  position: relative;
  width: 36px;
  min-width: 36px;
  height: 15px;
  flex: none;
  padding: 1.5px;
  box-sizing: border-box;
  border: 1.2px solid #71717a;
  border-radius: 4px;
  /* 未填充部分给一层浅灰，避免白色底和卡片背景融在一起显得图标变小 */
  background: rgba(15, 23, 42, 0.06);
  overflow: hidden;
}

.fill {
  position: absolute;
  inset: 1px;
  border-radius: 2px;
  background: var(--tone, #34c759);
  transform-origin: left center;
  transition: transform 0.3s ease, background-color 0.3s ease;
}

.nub {
  width: 2px;
  min-width: 2px;
  height: 5px;
  flex: none;
  margin-left: -0.5px;
  border-radius: 0 2px 2px 0;
  background: #71717a;
}

.value {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  color: #27272a;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.45);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.2px;
}
</style>