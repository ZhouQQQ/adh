<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NIcon } from 'naive-ui';
import { BatteryChargingOutline, BatteryHalfOutline } from '@vicons/ionicons5';
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
const low = computed(() => level.value !== null && level.value <= 20 && !charging.value);
</script>

<template>
  <span
    v-if="level !== null"
    class="battery"
    :class="{ charging, low }"
    :title="charging ? `充电中 · ${level}%` : `电量 ${level}%`"
  >
    <n-icon :size="13">
      <BatteryChargingOutline v-if="charging" />
      <BatteryHalfOutline v-else />
    </n-icon>
    <span>{{ level }}%</span>
  </span>
</template>

<style scoped>
.battery {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(6px);
  color: #18181b;
  font-size: 10px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.battery.charging {
  color: #16a34a;
  border-color: rgba(22, 163, 74, 0.35);
}

.battery.low {
  color: #dc2626;
  border-color: rgba(220, 38, 38, 0.35);
}
</style>