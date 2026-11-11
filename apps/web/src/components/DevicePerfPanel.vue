<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { PerfSample } from '@adh/protocol';
import { api } from '../api';
import PerfSparkline from './PerfSparkline.vue';

const props = defineProps<{
  deviceId: string;
  platform?: 'android' | 'ios';
}>();

/** 保留最近 90 个点：安卓约 3 分钟，iOS 约 6 分钟。 */
const CAPACITY = 90;

const samples = ref<PerfSample[]>([]);
const errorText = ref('');
const paused = ref(false);
const inFlight = ref(false);
let timer: number | null = null;
let disposed = false;

const intervalMs = computed(() => (props.platform === 'ios' ? 8_000 : 2_000));
let failures = 0;

const latest = computed<PerfSample | null>(
  () => samples.value[samples.value.length - 1] ?? null,
);

const memoryPercent = computed<number | null>(() => {
  const current = latest.value;
  if (!current?.memoryUsedMb || !current.memoryTotalMb) return null;
  return Math.min(
    100,
    Math.round((current.memoryUsedMb / current.memoryTotalMb) * 1000) / 10,
  );
});

const cpuText = computed(() => {
  const value = latest.value?.cpu;
  if (value === null || value === undefined) return '—';
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
});

const memoryText = computed(() => {
  const current = latest.value;
  if (!current?.memoryUsedMb || !current.memoryTotalMb) return '—';
  return `${memoryPercent.value ?? 0}%`;
});

const memoryHint = computed(() => {
  const current = latest.value;
  if (!current?.memoryUsedMb || !current.memoryTotalMb) return '暂不可用';
  const gb = (value: number): string => (value / 1024).toFixed(1);
  return `${gb(current.memoryUsedMb)} / ${gb(current.memoryTotalMb)} GB`;
});

const fpsText = computed(() => {
  const value = latest.value?.fps;
  if (value === null || value === undefined) return '—';
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} fps`;
});

const fpsMax = computed(() => {
  const peak = samples.value.reduce(
    (max, sample) => Math.max(max, sample.fps ?? 0),
    60,
  );
  return Math.min(240, Math.ceil(peak / 30) * 30);
});

const networkPeak = computed(() => {
  const peak = samples.value.reduce(
    (max, sample) =>
      Math.max(max, sample.networkRxKbps ?? 0, sample.networkTxKbps ?? 0),
    10,
  );
  return Math.max(10, Math.ceil(peak / 10) * 10);
});

const cpuValues = computed(() => samples.value.map((sample) => sample.cpu));
const memoryValues = computed(() =>
  samples.value.map((sample) => {
    if (!sample.memoryUsedMb || !sample.memoryTotalMb) return null;
    return (sample.memoryUsedMb / sample.memoryTotalMb) * 100;
  }),
);
const fpsValues = computed(() => samples.value.map((sample) => sample.fps));
const rxValues = computed(() =>
  samples.value.map((sample) => sample.networkRxKbps),
);
const txValues = computed(() =>
  samples.value.map((sample) => sample.networkTxKbps),
);

const memorySupported = computed(() =>
  samples.value.some((sample) => sample.memoryUsedMb !== null),
);

function formatKbps(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1024) return `${(value / 1024).toFixed(1)} MB/s`;
  if (value >= 10) return `${Math.round(value)} KB/s`;
  return `${value.toFixed(1)} KB/s`;
}

const networkText = computed(() => {
  const current = latest.value;
  if (!current || current.networkRxKbps === null) return '—';
  return `↓${formatKbps(current.networkRxKbps)} ↑${formatKbps(current.networkTxKbps)}`;
});

function clearTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

async function load(): Promise<void> {
  if (!props.deviceId || inFlight.value) return;
  inFlight.value = true;
  try {
    const sample = await api.getDevicePerf(props.deviceId);
    samples.value = [...samples.value, sample].slice(-CAPACITY);
    failures = 0;
    errorText.value = '';
  } catch (error) {
    const text = error instanceof Error ? error.message : '读取性能数据失败';
    failures += 1;
    // 偶发一次超时不要把整块图表变成错误页，连续失败两次再提示
    if (samples.value.length === 0 || failures >= 2) errorText.value = text;
  } finally {
    inFlight.value = false;
  }
}

function schedule(delay = intervalMs.value): void {
  clearTimer();
  if (disposed || paused.value) return;
  timer = window.setTimeout(() => {
    void runOnce();
  }, Math.max(300, delay));
}

async function runOnce(): Promise<void> {
  const startedAt = Date.now();
  await load();
  // 采样本身耗时（iOS 需要等 instruments 出样本），按固定节奏补齐间隔
  schedule(intervalMs.value - (Date.now() - startedAt));
}

function restart(): void {
  clearTimer();
  samples.value = [];
  errorText.value = '';
  failures = 0;
  if (!props.deviceId) return;
  void runOnce();
}

function togglePause(): void {
  paused.value = !paused.value;
  if (paused.value) clearTimer();
  else schedule();
}

async function refreshNow(): Promise<void> {
  clearTimer();
  await runOnce();
}

function onVisibilityChange(): void {
  if (document.hidden) clearTimer();
  else if (!paused.value) {
    clearTimer();
    void runOnce();
  }
}

onMounted(() => {
  disposed = false;
  document.addEventListener('visibilitychange', onVisibilityChange);
  restart();
});

onBeforeUnmount(() => {
  disposed = true;
  clearTimer();
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

watch(
  () => [props.deviceId, props.platform],
  () => {
    paused.value = false;
    restart();
  },
);
</script>

<template>
  <div class="perf">
    <div class="perf-head">
      <span class="live" :class="{ off: paused || Boolean(errorText) }" />
      <span class="head-text">
        {{ paused ? '已暂停' : errorText ? '采集失败' : '实时采样' }}
      </span>
      <span class="head-interval">{{ intervalMs / 1000 }}s</span>
      <div class="head-actions">
        <n-button size="tiny" quaternary :disabled="paused" @click="refreshNow">
          刷新
        </n-button>
        <n-button size="tiny" quaternary @click="togglePause">
          {{ paused ? '继续' : '暂停' }}
        </n-button>
      </div>
    </div>

    <div v-if="errorText && samples.length === 0" class="perf-error">
      {{ errorText }}
    </div>

    <template v-else>
      <div v-if="errorText" class="perf-warn">
        {{ errorText }}（图表为最后一次成功数据）
      </div>

      <div class="metrics">
        <div class="metric cpu">
          <div class="metric-top">
            <span class="metric-label">CPU</span>
            <span class="metric-value">{{ cpuText }}</span>
          </div>
          <div class="metric-chart">
            <PerfSparkline
              :values="cpuValues"
              :capacity="CAPACITY"
              :max="100"
              color="#3b82f6"
            />
          </div>
        </div>

        <div class="metric memory">
          <div class="metric-top">
            <span class="metric-label">内存</span>
            <span class="metric-value">{{ memoryText }}</span>
          </div>
          <div class="metric-hint">{{ memoryHint }}</div>
          <div class="metric-chart">
            <PerfSparkline
              :values="memoryValues"
              :capacity="CAPACITY"
              :max="100"
              color="#8b5cf6"
            />
          </div>
        </div>

        <div class="metric fps">
          <div class="metric-top">
            <span class="metric-label">帧率</span>
            <span class="metric-value">{{ fpsText }}</span>
          </div>
          <div class="metric-chart">
            <PerfSparkline
              :values="fpsValues"
              :capacity="CAPACITY"
              :max="fpsMax"
              color="#f59e0b"
            />
          </div>
        </div>

        <div v-if="platform !== 'ios'" class="metric network">
          <div class="metric-top">
            <span class="metric-label">网络</span>
            <span class="metric-value net">{{ networkText }}</span>
          </div>
          <div class="metric-chart">
            <PerfSparkline
              :values="rxValues"
              :values2="txValues"
              :capacity="CAPACITY"
              :max="networkPeak"
              color="#0ea5e9"
              color2="#22c55e"
            />
          </div>
          <div class="net-legend">
            <span class="dot rx" />下行
            <span class="dot tx" />上行
          </div>
        </div>
      </div>

      <div class="perf-note">
        <template v-if="platform === 'ios' && !memorySupported">
          iOS 暂不支持读取内存 / 网络；CPU 来自 go-ios sysmontap，帧率需要较新的 go-ios。
        </template>
        <template v-else-if="platform === 'ios'">
          iOS 帧率需要较新的 go-ios；画面静止或熄屏时接近 0。
        </template>
        <template v-else>
          帧率为整屏绘制帧率；网络为除 loopback 外的全部网卡合计。
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.perf-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.live {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.14);
}

.live.off {
  background: #a1a1aa;
  box-shadow: none;
}

.head-text {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}

.head-interval {
  font-size: 10px;
  color: var(--text-faint);
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.05);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.metrics {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.metric-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.metric-label {
  font-size: 11px;
  color: var(--text-dim);
}

.metric-value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.metric.cpu .metric-value {
  color: #2563eb;
}

.metric.memory .metric-value {
  color: #7c3aed;
}

.metric.fps .metric-value {
  color: #d97706;
}

.metric.network .metric-value {
  font-size: 12px;
  color: #0284c7;
}

.net-legend {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--text-faint);
}

.net-legend .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.net-legend .dot.rx {
  background: #0ea5e9;
}

.net-legend .dot.tx {
  margin-left: 6px;
  background: #22c55e;
}

.metric-hint {
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.metric-chart {
  height: 38px;
}

.perf-note {
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-faint);
}

.perf-error {
  padding: 12px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
  text-align: center;
}

.perf-warn {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff7ed;
  color: #b45309;
  font-size: 10px;
  line-height: 1.5;
}
</style>
