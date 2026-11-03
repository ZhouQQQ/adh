<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NIcon } from 'naive-ui';
import { FlashOutline } from '@vicons/ionicons5';
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
const temperatureHot = computed(() => (temperature.value ?? 0) >= 40);

const tone = computed(() => {
  const value = level.value ?? 0;
  if (value <= 20) return 'low';
  if (value <= 50) return 'mid';
  return 'high';
});

const fillWidth = computed(() => {
  const value = Math.min(100, Math.max(0, level.value ?? 0));
  return `${value}%`;
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
    <span class="shell">
      <span class="fill" :style="{ width: fillWidth }" />
      <span class="value" :class="{ 'with-bolt': charging }">{{ level }}%</span>
      <n-icon v-if="charging" class="bolt" :size="8">
        <FlashOutline />
      </n-icon>
    </span>
    <span class="tip" />
    <span v-if="temperatureText" class="temp" :class="{ hot: temperatureHot }">
      {{ temperatureText }}
    </span>
  </span>
</template>

<style scoped>
.battery {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 0;
}

.battery.low {
  --tone: #ef4444;
}

.battery.mid {
  --tone: #f59e0b;
}

.battery.high {
  --tone: #22c55e;
}

.shell {
  position: relative;
  width: 46px;
  height: 16px;
  padding: 1.5px;
  box-sizing: border-box;
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  background: #fff;
  overflow: hidden;
}

.fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 0;
  background: var(--tone, #22c55e);
  background-image: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.3),
    rgba(255, 255, 255, 0)
  );
  transition: width 0.3s ease, background-color 0.3s ease;
}

.value {
  position: relative;
  z-index: 1;
  display: block;
  text-align: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 12px;
  color: #ffffff;
  text-shadow: 0 1px 2px rgba(9, 9, 11, 0.55);
  -webkit-text-stroke: 0.4px rgba(9, 9, 11, 0.35);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.2px;
}

/* 充电时给内部闪电留位置 */
.value.with-bolt {
  padding-left: 7px;
}

/* 电池正极：紧贴电池体，看起来连在一起 */
.tip {
  width: 3px;
  height: 7px;
  margin-left: -1px;
  border-radius: 0 2px 2px 0;
  background: #d4d4d8;
}

.bolt {
  position: absolute;
  left: 1px;
  top: 50%;
  z-index: 2;
  transform: translateY(-50%);
  color: #ffffff;
  filter: drop-shadow(0 1px 1px rgba(9, 9, 11, 0.55));
}

.temp {
  margin-left: 3px;
  font-size: 10px;
  line-height: 1;
  color: #71717a;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.temp.hot {
  color: #dc2626;
  font-weight: 600;
}
</style>