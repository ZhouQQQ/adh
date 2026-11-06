<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { NButton, NSlider, NSpin, NTag } from 'naive-ui';
import {
  api,
  type TaskReplay,
  type TaskReplayAction,
  type TaskReplayFrame,
} from '../api';

const route = useRoute();
const token = computed(() => String(route.params.token ?? ''));

const data = ref<TaskReplay | null>(null);
const loading = ref(true);
const error = ref('');
const index = ref(0);
const playing = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

const frames = computed<TaskReplayFrame[]>(() => data.value?.frames ?? []);
const current = computed<TaskReplayFrame | null>(
  () => frames.value[index.value] ?? null,
);
const task = computed(() => data.value?.task ?? null);
const startedAt = computed(
  () => task.value?.startedAt || frames.value[0]?.at || 0,
);

const statusText = computed(() => {
  switch (task.value?.status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '成功';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'timeout':
      return '超时';
    default:
      return '未知';
  }
});

const statusType = computed<'success' | 'error' | 'warning' | 'info' | 'default'>(
  () => {
    switch (task.value?.status) {
      case 'succeeded':
        return 'success';
      case 'failed':
        return 'error';
      case 'cancelled':
      case 'timeout':
        return 'warning';
      case 'queued':
      case 'running':
        return 'info';
      default:
        return 'default';
    }
  },
);

const durationText = computed(() => {
  if (!task.value) return '—';
  const end = task.value.finishedAt || Date.now();
  const start = task.value.startedAt || task.value.createdAt;
  if (!start) return '—';
  return formatDuration(Math.max(0, end - start));
});

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function relativeTime(at: number): string {
  if (!startedAt.value) return '0:00';
  const seconds = Math.max(0, Math.round((at - startedAt.value) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function frameSrc(frame: TaskReplayFrame | null): string {
  if (!frame) return '';
  return api.taskReplayFrameUrl(token.value, frame.file);
}

function actionLabel(name: string): string {
  switch (name) {
    case 'tap':
      return '点击';
    case 'swipe':
      return '滑动';
    case 'input_text':
      return '输入文字';
    case 'press_key':
      return '按键';
    case 'wait':
      return '等待';
    case 'launch_app':
      return '启动应用';
    case 'plan':
      return '制定计划';
    case 'done':
      return '完成任务';
    default:
      return name;
  }
}

function actionArgs(action: TaskReplayAction): string {
  return Object.entries(action.args)
    .map(([key, value]) => {
      const text =
        typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}=${text}`;
    })
    .join(', ');
}

function stepArgs(step: TaskReplay['task']['steps'][number]): string {
  return Object.entries(step.args ?? {})
    .map(([key, value]) => {
      const text =
        typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}=${text}`;
    })
    .join(', ');
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(): void {
  clearTimer();
  if (!playing.value) return;
  const next = frames.value[index.value + 1];
  if (!next) {
    playing.value = false;
    return;
  }
  const at = current.value?.at ?? next.at;
  // 真实间隔可能很长，播放时压缩到 0.7~2.5 秒，避免一个停顿等太久
  const delay = Math.min(2500, Math.max(700, next.at - at));
  timer = setTimeout(() => {
    index.value += 1;
    if (index.value >= frames.value.length - 1) {
      playing.value = false;
      return;
    }
    scheduleNext();
  }, delay);
}

function togglePlay(): void {
  if (frames.value.length < 2) return;
  if (playing.value) {
    playing.value = false;
    clearTimer();
    return;
  }
  if (index.value >= frames.value.length - 1) index.value = 0;
  playing.value = true;
  scheduleNext();
}

function seek(value: number | [number, number]): void {
  playing.value = false;
  clearTimer();
  const next = Array.isArray(value) ? value[0] : value;
  index.value = Math.min(
    frames.value.length - 1,
    Math.max(0, Math.round(next)),
  );
}

function step(delta: number): void {
  playing.value = false;
  clearTimer();
  index.value = Math.min(
    frames.value.length - 1,
    Math.max(0, index.value + delta),
  );
}

async function load(): Promise<void> {
  if (!token.value) {
    error.value = '缺少回放 token';
    loading.value = false;
    return;
  }
  try {
    data.value = await api.getTaskReplay(token.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载回放失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

onBeforeUnmount(() => {
  clearTimer();
});
</script>

<template>
  <div class="replay-page">
    <n-spin :show="loading">
      <div v-if="error" class="replay-error">
        <h1>无法打开回放</h1>
        <p>{{ error }}</p>
      </div>

      <template v-else-if="task">
        <header class="replay-header">
          <div class="header-main">
            <div class="eyebrow">任务回放</div>
            <h1>{{ task.instruction }}</h1>
            <div class="meta-line">
              <span>设备 {{ task.deviceId ?? '—' }}</span>
              <span>耗时 {{ durationText }}</span>
              <span>共 {{ frames.length }} 帧</span>
            </div>
          </div>
          <n-tag :type="statusType" size="small">{{ statusText }}</n-tag>
        </header>

        <div class="replay-grid">
          <section class="panel player-panel">
            <div class="screen">
              <img
                v-if="current"
                :src="frameSrc(current)"
                :alt="`第 ${index + 1} 帧`"
              />
              <div v-else class="screen-empty">
                {{
                  task?.status === 'running' || task?.status === 'queued'
                    ? '任务执行中，画面会在任务结束后生成。'
                    : '这个任务没有保存画面，请在右侧查看执行记录。'
                }}
              </div>
            </div>

            <div class="controls">
              <n-button size="small" secondary @click="step(-1)">上一帧</n-button>
              <n-button
                size="small"
                type="primary"
                :disabled="frames.length < 2"
                @click="togglePlay"
              >
                {{ playing ? '暂停' : '播放' }}
              </n-button>
              <n-button size="small" secondary @click="step(1)">下一帧</n-button>
              <n-slider
                class="slider"
                :min="0"
                :max="Math.max(0, frames.length - 1)"
                :step="1"
                :value="index"
                :disabled="frames.length < 2"
                @update:value="seek"
              />
              <span class="counter">
                {{ frames.length ? index + 1 : 0 }} / {{ frames.length }}
              </span>
            </div>

            <div v-if="current" class="frame-info">
              <div class="frame-title">
                <span class="phase">
                  {{ current.phase === 'initial' ? '初始画面' : '动作后' }}
                </span>
                <span class="time">+{{ relativeTime(current.at) }}</span>
              </div>
              <p class="frame-summary">{{ current.summary }}</p>
              <ul v-if="current.actions.length" class="actions">
                <li v-for="(action, i) in current.actions" :key="i">
                  <div class="action-head">
                    <strong>{{ actionLabel(action.name) }}</strong>
                    <span :class="{ failed: !action.ok }">
                      {{ action.ok ? '成功' : '未生效' }}
                    </span>
                  </div>
                  <code v-if="actionArgs(action)">{{ actionArgs(action) }}</code>
                  <p>{{ action.detail }}</p>
                </li>
              </ul>
              <p v-else class="empty-actions">这是任务开始时的画面。</p>
            </div>
          </section>

          <aside class="panel steps-panel">
            <h2>执行记录</h2>
            <ol class="steps">
              <li v-for="(step, i) in task.steps" :key="i">
                <div class="step-head">
                  <span class="step-name">{{ actionLabel(step.name) }}</span>
                  <span :class="{ failed: step.ok === false }">
                    {{ step.ok === false ? '失败' : step.ok ? '成功' : '执行' }}
                  </span>
                </div>
                <code v-if="stepArgs(step)">{{ stepArgs(step) }}</code>
                <p v-if="step.detail">{{ step.detail }}</p>
              </li>
            </ol>
            <p v-if="!task.steps.length" class="empty-actions">没有执行记录。</p>
          </aside>
        </div>

        <section class="panel result-panel">
          <div class="result-label">任务结果</div>
          <p>{{ task.reply || task.error || statusText }}</p>
        </section>
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.replay-page {
  min-height: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 20px 48px;
  background: var(--bg);
  color: var(--text);
}

.replay-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header-main {
  min-width: 0;
}

.eyebrow {
  margin-bottom: 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.replay-header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.replay-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  margin-top: 18px;
}

.panel {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 14px;
}

.screen {
  display: grid;
  place-items: center;
  min-height: 260px;
  max-height: 62vh;
  overflow: hidden;
  border-radius: 8px;
  background: #09090b;
}

.screen img {
  display: block;
  max-width: 100%;
  max-height: 62vh;
  object-fit: contain;
}

.screen-empty {
  padding: 48px 20px;
  font-size: 12px;
  text-align: center;
  color: #d4d4d8;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.slider {
  flex: 1;
  min-width: 80px;
}

.counter {
  min-width: 54px;
  font-size: 11px;
  text-align: right;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.frame-info {
  margin-top: 12px;
}

.frame-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.phase {
  font-weight: 600;
}

.time {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.frame-summary {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.actions {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.actions li {
  margin-top: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--surface-2);
}

.action-head,
.step-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.action-head span,
.step-head span {
  color: #16a34a;
}

.action-head .failed,
.step-head .failed {
  color: #dc2626;
}

.actions code,
.steps code {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}

.actions p,
.steps p {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.empty-actions {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-faint);
}

.steps-panel {
  max-height: 70vh;
  overflow: auto;
}

.steps-panel h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}

.steps {
  margin: 0;
  padding-left: 18px;
}

.steps li {
  margin-bottom: 10px;
  font-size: 12px;
}

.steps li::marker {
  color: var(--text-faint);
  font-size: 10px;
}

.step-name {
  font-weight: 600;
  color: var(--text);
}

.result-panel {
  margin-top: 16px;
}

.result-label {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text-faint);
}

.result-panel p {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.replay-error {
  padding: 72px 20px;
  text-align: center;
}

.replay-error h1 {
  margin: 0 0 8px;
  font-size: 18px;
}

.replay-error p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

@media (max-width: 860px) {
  .replay-grid {
    grid-template-columns: 1fr;
  }

  .steps-panel {
    max-height: none;
  }
}
</style>