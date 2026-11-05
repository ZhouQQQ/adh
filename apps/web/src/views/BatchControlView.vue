<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NEmpty,
  NIcon,
  NInput,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  ArrowUpOutline,
  CloseOutline,
  CloudDownloadOutline,
  ReorderTwoOutline,
  SparklesOutline,
} from '@vicons/ionicons5';
import { BUILTIN_AGENT_ID } from '@adh/protocol';
import type { DeviceSummary, ViewerToStreamMessage } from '@adh/protocol';
import DevicePlayer from '../components/DevicePlayer.vue';
import BulkInstallModal from '../components/BulkInstallModal.vue';
import AddBatchDevicesModal from '../components/AddBatchDevicesModal.vue';
import { api } from '../api';
import type { TaskSnapshot } from '../api';
import { useFleet } from '../stores/fleet';
import {
  WEB_CODECS_TITLE,
  isWebCodecsAvailable,
  webCodecsHints,
  webCodecsReason,
} from '../utils/webcodecs';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const { devices } = useFleet();

function parseIds(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const selectedIds = ref<string[]>(parseIds(route.query.ids));
const sessions = ref<Record<string, string>>({});
const controllers = ref<Record<string, boolean>>({});
const connecting = ref<Record<string, boolean>>({});
/** iOS 是单控制者模型：批量页也要自己申请控制权并保持心跳。 */
const iosHeartbeats = new Map<string, number>();
const iosClaimPending = new Set<string>();
const iosClaimAttempted = new Set<string>();
/** 安卓批量画面同样依赖 WebCodecs，非安全上下文下直接提示，不建会话。 */
const codecBlocked = ref(!isWebCodecsAvailable());
const codecHints = computed(() => webCodecsHints());
const installShow = ref(false);
const addShow = ref(false);
/** 右下角唯一的 AI 对话入口：AI 自己判断单台还是批量。 */
const chatOpen = ref(false);
const chatInput = ref('');
const chatBusy = ref(false);
const chatScrollRef = ref<HTMLElement | null>(null);
const wallZoom = ref(0.5);
let chatTimer: number | null = null;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tasks: TaskSnapshot[];
  error?: boolean;
}

let chatSeq = 0;
function chatId(): string {
  chatSeq += 1;
  return `chat-${Date.now()}-${chatSeq}`;
}

/** push 后取回数组里的响应式代理，后续改 content/tasks 才能触发界面更新。 */
function addChatMessage(item: Omit<ChatMessage, 'id'>): ChatMessage {
  chatMessages.value.push({ ...item, id: chatId() });
  return chatMessages.value[chatMessages.value.length - 1]!;
}

const chatMessages = ref<ChatMessage[]>([
  {
    id: chatId(),
    role: 'assistant',
    content:
      '告诉我你想让设备做什么，我会自己判断是单台还是多台。\n\n例如：\n· 所有设备一起打开共享商家端，用测试账号登录\n· Redmi K30 Pro 给 iPhone 11 发消息「你好」，iPhone 收到后回复「你也好」',
    tasks: [],
  },
]);
/** 所有设备统一画质，默认中。 */
const quality = ref<'low' | 'medium' | 'high' | 'ultra'>('medium');
const switchingQuality = ref(false);
/** 联动：一台设备的输入同步到其余设备。 */
const linkEnabled = ref(false);
/** 按住 Alt 时临时解除联动。 */
const linkPaused = ref(false);
/** 正在拖动的设备 id，用于排序。 */
const draggingId = ref<string | null>(null);
/** 拖动经过的目标卡片，用于高亮。 */
const dragOverId = ref<string | null>(null);

const playerRefs = new Map<string, InstanceType<typeof DevicePlayer>>();
/** 最近一次正在进行的触摸，临时解除联动时用它补一个 ended，避免其他设备卡住。 */
let lastTouch: { id: string; message: ViewerToStreamMessage } | null = null;

function setPlayerRef(id: string, value: unknown): void {
  if (value) playerRefs.set(id, value as InstanceType<typeof DevicePlayer>);
  else playerRefs.delete(id);
}

function releaseMirrors(): void {
  const pending = lastTouch;
  if (!pending || pending.message.t !== 'touch') return;
  lastTouch = null;
  const end: ViewerToStreamMessage = {
    t: 'touch',
    phase: 'ended',
    x: pending.message.x,
    y: pending.message.y,
    pointerId: 0,
    pressure: 0,
  };
  for (const [id, player] of playerRefs) {
    if (id === pending.id) continue;
    player.applyInput(end);
  }
}

function onInput(sourceId: string, message: ViewerToStreamMessage): void {
  lastTouch =
    message.t === 'touch' && message.phase !== 'ended'
      ? { id: sourceId, message }
      : null;

  if (!linkEnabled.value || linkPaused.value) return;
  for (const [id, player] of playerRefs) {
    if (id === sourceId) continue;
    player.applyInput(message);
  }
}

function onAltDown(event: KeyboardEvent): void {
  if (event.key !== 'Alt' || !linkEnabled.value) return;
  // 阻止 Windows 浏览器把 Alt 用于聚焦菜单栏
  event.preventDefault();
  if (linkPaused.value) return;
  releaseMirrors();
  linkPaused.value = true;
}

function onAltUp(event: KeyboardEvent): void {
  if (event.key !== 'Alt') return;
  linkPaused.value = false;
}

function onWindowBlur(): void {
  if (linkPaused.value) releaseMirrors();
  linkPaused.value = false;
}

/** 离开批量页时释放预览；force 时连正在执行 AI 任务的设备一起断开。 */
function releasePreviewSessions(force = false): void {
  const busy = aiBusyDeviceIds.value;
  for (const id of selectedIds.value) {
    if (!force && busy.has(id)) continue;
    if (controllers.value[id] !== true) continue;
    void api.stopDeviceStream(id).catch(() => undefined);
  }
}

function pendingChatTasks(): TaskSnapshot[] {
  return allChatTasks().filter((task) => !AI_TERMINAL.has(task.status));
}

async function cancelPendingTasks(): Promise<void> {
  await Promise.all(
    pendingChatTasks().map((task) =>
      api.cancelTask(task.id).catch(() => undefined),
    ),
  );
}

function confirmExitWithTasks(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.warning({
      title: '退出批量控制？',
      content: `有 ${count} 个 AI 任务正在执行。退出会取消这些任务并断开所有设备，确定退出？`,
      positiveText: '退出并停止任务',
      negativeText: '继续留在页面',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
    });
  });
}

let exiting = false;

async function requestBatchExit(): Promise<void> {
  if (exiting) return;
  const pending = pendingChatTasks();
  if (pending.length > 0) {
    const ok = await confirmExitWithTasks(pending.length);
    if (!ok) return;
  }

  exiting = true;
  await cancelPendingTasks();
  releasePreviewSessions(true);
  stopChatPoll();
  for (const id of [...iosHeartbeats.keys()]) stopIosHeartbeat(id);

  window.close();
  window.setTimeout(() => {
    if (!window.closed) void router.push('/devices');
  }, 200);
}

function onBatchExitRequest(): void {
  void requestBatchExit();
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return;
  // 直接关标签页 / 刷新时也要停任务并释放设备
  void cancelPendingTasks();
  releasePreviewSessions(true);
}

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) void syncSessions();
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  // 有任务在跑时给一次确认，避免误关后看不到执行状态
  if (exiting || aiBusyDeviceIds.value.size === 0) return;
  event.preventDefault();
  event.returnValue = '';
}

onMounted(() => {
  window.addEventListener('keydown', onAltDown);
  window.addEventListener('keyup', onAltUp);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('adh:batch-exit', onBatchExitRequest);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onAltDown);
  window.removeEventListener('keyup', onAltUp);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('pageshow', onPageShow);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('adh:batch-exit', onBatchExitRequest);
  void cancelPendingTasks();
  releasePreviewSessions(true);
  stopChatPoll();
  for (const id of [...iosHeartbeats.keys()]) stopIosHeartbeat(id);
});

watch(linkEnabled, (enabled) => {
  if (!enabled) {
    releaseMirrors();
    linkPaused.value = false;
  }
});

const controlDevices = computed(() =>
  devices.value.filter(
    (device) =>
      device.status === 'online' &&
      (device.platform === 'android' || device.capabilities.includes('wda')),
  ),
);

const selectedDevices = computed(() =>
  selectedIds.value
    .map((id) => devices.value.find((device) => device.id === id))
    .filter((device): device is NonNullable<typeof device> => Boolean(device)),
);

/** 批量安装弹窗展示所有选中设备，具体装哪些由 APK / IPA 类型决定。 */
const installTargets = computed(() =>
  selectedDevices.value.map((device) => ({
    id: device.id,
    name: device.name,
    platform: device.platform,
  })),
);

/** 卡片按设备分辨率取宽高比，画面刚好填满，避免四周大片黑边。 */
function tileRatio(device: DeviceSummary): string {
  const resolution = device.resolution;
  return resolution
    ? `${resolution.width} / ${resolution.height}`
    : '9 / 19.5';
}

function addDevices(ids: string[]): void {
  selectedIds.value = [...new Set([...selectedIds.value, ...ids])];
}

/* ------------------------------------------------------------------ */
/* AI 对话（单台 / 批量由模型判断）                                    */
/* ------------------------------------------------------------------ */

const AI_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

function deviceName(deviceId: string | null): string {
  if (!deviceId) return '未知设备';
  return devices.value.find((device) => device.id === deviceId)?.name ?? deviceId;
}

function taskStatusLabel(status: TaskSnapshot['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'timeout':
      return '超时';
    default:
      return '失败';
  }
}

function taskStatusType(
  status: TaskSnapshot['status'],
): 'default' | 'info' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'queued':
      return 'default';
    case 'running':
      return 'info';
    case 'succeeded':
      return 'success';
    case 'cancelled':
      return 'warning';
    case 'timeout':
      return 'warning';
    default:
      return 'error';
  }
}

function allChatTasks(): TaskSnapshot[] {
  const byId = new Map<string, TaskSnapshot>();
  for (const item of chatMessages.value) {
    for (const task of item.tasks) byId.set(task.id, task);
  }
  return [...byId.values()];
}

/** 正在被 AI 任务占用的设备，瓦片显示对应提示而不是“等待连接”。 */
const aiBusyDeviceIds = computed(
  () =>
    new Set(
      allChatTasks()
        .filter((task) => !AI_TERMINAL.has(task.status) && task.deviceId)
        .map((task) => task.deviceId as string),
    ),
);

async function scrollChatToBottom(): Promise<void> {
  await nextTick();
  const el = chatScrollRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function toggleChat(): void {
  chatOpen.value = !chatOpen.value;
  if (chatOpen.value) void scrollChatToBottom();
}

function stopChatPoll(): void {
  if (chatTimer !== null) {
    window.clearInterval(chatTimer);
    chatTimer = null;
  }
}

function resetIosClaimsForTasks(tasks: TaskSnapshot[]): void {
  for (const task of tasks) {
    if (task.deviceId) iosClaimAttempted.delete(task.deviceId);
  }
}

async function pollChatTasks(): Promise<void> {
  const tasks = allChatTasks();
  if (tasks.length === 0) {
    stopChatPoll();
    return;
  }

  const pending = tasks.filter((task) => !AI_TERMINAL.has(task.status));
  if (pending.length === 0) {
    stopChatPoll();
    resetIosClaimsForTasks(tasks);
    // 任务结束后把批量预览重新接上
    window.setTimeout(() => void syncSessions(), 800);
    return;
  }

  await Promise.all(
    pending.map(async (task) => {
      try {
        const { task: fresh } = await api.getTask(task.id);
        Object.assign(task, fresh);
      } catch {
        /* 单次轮询失败不打断整批 */
      }
    }),
  );

  if (allChatTasks().every((task) => AI_TERMINAL.has(task.status))) {
    stopChatPoll();
    resetIosClaimsForTasks(allChatTasks());
    window.setTimeout(() => void syncSessions(), 800);
  }
}

function startChatPoll(): void {
  stopChatPoll();
  chatTimer = window.setInterval(() => void pollChatTasks(), 1500);
}

/** 中文输入法候选词确认也会触发 Enter，不能直接发送。 */
let chatComposing = false;

function onChatCompositionStart(): void {
  chatComposing = true;
}

function onChatCompositionEnd(): void {
  chatComposing = false;
}

function onChatEnter(event: KeyboardEvent): void {
  if (event.shiftKey || event.isComposing || chatComposing) return;
  event.preventDefault();
  void sendChat();
}

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || chatBusy.value) return;

  chatMessages.value.push({
    id: chatId(),
    role: 'user',
    content: text,
    tasks: [],
  });
  chatInput.value = '';
  chatBusy.value = true;
  void scrollChatToBottom();

  let assistant: ChatMessage | null = null;
  let summary = '';
  try {
    const { plan } = await api.planBatchTasks({
      instruction: text,
      deviceIds: selectedIds.value.slice(0, 50),
    });
    summary = plan.summary;
    assistant = addChatMessage({
      role: 'assistant',
      content: plan.summary,
      tasks: [],
    });

    if (plan.scope === 'none' || plan.tasks.length === 0) {
      assistant.content =
        plan.summary || '我没听出要执行什么操作，请说得更具体一点。';
      return;
    }

    // 不主动断开预览：后端任务会复用当前会话，用户能继续看到执行过程
    const { tasks } = await api.createBatchTasks({
      tasks: plan.tasks,
      mode: plan.mode,
    });
    assistant.tasks = tasks;
    const modeHint =
      tasks.length > 1
        ? plan.mode === 'sequential'
          ? '，按设备顺序执行'
          : '，并行执行'
        : '';
    assistant.content = `${plan.summary}\n\n已创建 ${tasks.length} 个任务${modeHint}。`;
    message.success(`已创建 ${tasks.length} 个 AI 任务`);
    startChatPoll();
  } catch (error) {
    const detail = error instanceof Error ? error.message : '创建任务失败';
    if (assistant) {
      assistant.error = true;
      assistant.content = summary ? `${summary}\n\n${detail}` : detail;
    } else {
      addChatMessage({
        role: 'assistant',
        content: detail,
        tasks: [],
        error: true,
      });
    }
    // 如果已经断过预览，把选中设备的预览接回来
    window.setTimeout(() => void syncSessions(), 500);
  } finally {
    chatBusy.value = false;
    void scrollChatToBottom();
  }
}

function zoomWall(delta: number): void {
  const next = Math.round((wallZoom.value + delta) * 10) / 10;
  wallZoom.value = Math.min(2, Math.max(0.1, next));
}

function resetWallZoom(): void {
  wallZoom.value = 0.5;
}

let syncing = false;

function stopIosHeartbeat(deviceId: string): void {
  const timer = iosHeartbeats.get(deviceId);
  if (timer !== undefined) {
    window.clearInterval(timer);
    iosHeartbeats.delete(deviceId);
  }
}

function startIosHeartbeat(deviceId: string): void {
  stopIosHeartbeat(deviceId);
  const timer = window.setInterval(() => {
    void api
      .heartbeatIosControl(deviceId)
      .then((result) => {
        if (result.ok) return;
        stopIosHeartbeat(deviceId);
        controllers.value = { ...controllers.value, [deviceId]: false };
        iosClaimAttempted.delete(deviceId);
        message.warning(`${deviceName(deviceId)} 的 iOS 控制权已释放`);
        window.setTimeout(() => void syncIosControls(), 500);
      })
      .catch(() => undefined);
  }, 10_000);
  iosHeartbeats.set(deviceId, timer);
}

async function syncIosControls(): Promise<void> {
  for (const id of selectedIds.value) {
    const device = devices.value.find((item) => item.id === id);
    if (!device || device.platform !== 'ios') continue;
    // AI 任务期间设备被任务独占，不要和任务抢 iOS 控制权
    if (aiBusyDeviceIds.value.has(id)) continue;
    if (
      controllers.value[id] === true ||
      iosClaimPending.has(id) ||
      iosClaimAttempted.has(id)
    ) {
      continue;
    }

    iosClaimAttempted.add(id);
    iosClaimPending.add(id);
    try {
      const result = await api.claimIosControl(id);
      if (result.granted) {
        controllers.value = { ...controllers.value, [id]: true };
        startIosHeartbeat(id);
      } else {
        controllers.value = { ...controllers.value, [id]: false };
        message.warning(
          `${device.name}: ${result.control?.username ?? '其他用户'} 正在控制，当前仅查看`,
        );
      }
    } catch (error) {
      controllers.value = { ...controllers.value, [id]: false };
      message.error(
        `${device.name}: ${error instanceof Error ? error.message : '申请 iOS 控制权失败'}`,
      );
    } finally {
      iosClaimPending.delete(id);
    }
  }
}

async function syncSessions(): Promise<void> {
  if (syncing) return;
  syncing = true;

  try {
    // iOS 是单控制者模型：先确保当前批量页拿到控制权
    await syncIosControls();
    if (codecBlocked.value) return;

    const ids = selectedIds.value;
    for (const id of ids) {
      const device = devices.value.find((item) => item.id === id);
      if (!device) continue;
      // 本机 iOS 走 WDA HTTP，不需要会话；远程 iOS 由 agent 推流，需要建会话
      if (device.platform === 'ios' && device.agentId === BUILTIN_AGENT_ID) {
        continue;
      }
      if (sessions.value[id] || connecting.value[id]) continue;

      connecting.value = { ...connecting.value, [id]: true };
      try {
        const { sessionId } = await api.createStream(id, quality.value);
        sessions.value = { ...sessions.value, [id]: sessionId };
      } catch (error) {
        const name = device.name ?? id;
        message.error(
          `${name}: ${error instanceof Error ? error.message : '连接失败'}`,
        );
      } finally {
        const next = { ...connecting.value };
        delete next[id];
        connecting.value = next;
      }
    }

    const nextSessions = { ...sessions.value };
    for (const id of Object.keys(nextSessions)) {
      if (!ids.includes(id)) delete nextSessions[id];
    }
    sessions.value = nextSessions;
  } finally {
    syncing = false;
  }
}

// 只跟随选中项和在线状态变化，避免电量等设备更新反复触建会话
watch(
  [
    selectedIds,
    () => selectedDevices.value.map((item) => `${item.id}:${item.status}`).join('|'),
  ],
  () => void syncSessions(),
  { immediate: true },
);

function removeDevice(id: string): void {
  const device = devices.value.find((item) => item.id === id);
  selectedIds.value = selectedIds.value.filter((item) => item !== id);
  stopIosHeartbeat(id);
  iosClaimAttempted.delete(id);
  if (device?.platform === 'ios') {
    void api.stopDeviceStream(id).catch(() => undefined);
  }
}

function onDragStart(id: string, event: DragEvent): void {
  draggingId.value = id;
  dragOverId.value = null;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
}

function onDragEnd(): void {
  draggingId.value = null;
  dragOverId.value = null;
}

function onDragLeave(id: string, event: DragEvent): void {
  const current = event.currentTarget as HTMLElement;
  const next = event.relatedTarget as Node | null;
  if (next && current.contains(next)) return;
  if (dragOverId.value === id) dragOverId.value = null;
}

/** 把拖动的设备插到目标设备的位置。 */
function onDrop(targetId: string): void {
  const sourceId = draggingId.value;
  draggingId.value = null;
  dragOverId.value = null;
  if (!sourceId || sourceId === targetId) return;

  const next = [...selectedIds.value];
  const from = next.indexOf(sourceId);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) return;

  next.splice(from, 1);
  next.splice(to, 0, sourceId);
  selectedIds.value = next;
}

// 顺序写回 URL，刷新后保持
watch(selectedIds, (ids) => {
  void router.replace({ query: { ...route.query, ids: ids.join(',') } });
});

function onControllerChange(deviceId: string, value: boolean): void {
  controllers.value = { ...controllers.value, [deviceId]: value };
}

async function onQualityChange(
  value: 'low' | 'medium' | 'high' | 'ultra',
): Promise<void> {
  quality.value = value;

  // Android 会话需要按新画质重建；iOS 由 DevicePlayer 重新挂载后拉流
  const androidIds = selectedDevices.value
    .filter((device) => device.platform === 'android' && sessions.value[device.id])
    .map((device) => device.id);
  if (androidIds.length === 0) return;

  switchingQuality.value = true;
  try {
    const next = { ...sessions.value };
    await Promise.all(
      androidIds.map(async (id) => {
        const result = await api.restartStream(id, value);
        next[id] = result.sessionId;
      }),
    );
    sessions.value = next;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '切换画质失败');
  } finally {
    switchingQuality.value = false;
  }
}
</script>

<template>
  <div class="batch-page">
    <header class="batch-toolbar">
      <div class="tool-group">
        <n-button size="small" @click="addShow = true">
          <template #icon>
            <n-icon :component="AddOutline" />
          </template>
          添加设备
        </n-button>
        <n-button
          size="small"
          :disabled="installTargets.length === 0"
          @click="installShow = true"
        >
          <template #icon>
            <n-icon :component="CloudDownloadOutline" />
          </template>
          批量安装
        </n-button>
        <span class="batch-count">{{ selectedIds.length }} 台</span>
      </div>

      <span class="tool-divider" />

      <div class="tool-group">
        <label class="link-switch">
          <n-switch v-model:value="linkEnabled" size="small" />
          <span>联动</span>
        </label>
        <span v-if="linkEnabled" class="link-hint" :class="{ paused: linkPaused }">
          {{ linkPaused ? '已临时解除，松开 Alt 恢复' : '按住 Alt 临时解除' }}
        </span>
      </div>

      <div class="tool-group right">
        <div class="wall-zoom" title="缩放设备墙">
          <button type="button" @click="zoomWall(-0.1)">−</button>
          <span>{{ Math.round(wallZoom * 100) }}%</span>
          <button type="button" @click="zoomWall(0.1)">+</button>
          <button type="button" class="wall-zoom-reset" @click="resetWallZoom">
            重置
          </button>
        </div>
        <n-select
          v-model:value="quality"
          size="tiny"
          class="quality-select"
          :options="[
            { label: '低画质', value: 'low' },
            { label: '中画质', value: 'medium' },
            { label: '高画质', value: 'high' },
            { label: '极高画质', value: 'ultra' },
          ]"
          :disabled="switchingQuality"
          @update:value="onQualityChange"
        />
      </div>
    </header>

    <n-alert
      v-if="codecBlocked"
      type="error"
      class="codec-alert"
      :bordered="false"
    >
      <template #header>{{ WEB_CODECS_TITLE }}</template>
      <div>{{ webCodecsReason() }}</div>
      <ul class="codec-hints">
        <li v-for="hint in codecHints" :key="hint">{{ hint }}</li>
      </ul>
    </n-alert>

    <TransitionGroup
      v-if="selectedDevices.length > 0"
      name="tile"
      tag="div"
      class="batch-grid"
      :style="{ '--wall-zoom': wallZoom }"
    >
      <section
        v-for="device in selectedDevices"
        :key="device.id"
        class="tile"
        :class="{
          dragging: draggingId === device.id,
          'drag-over': dragOverId === device.id && draggingId !== device.id,
          micro: wallZoom < 0.3,
        }"
        :style="{ '--tile-ratio': tileRatio(device) }"
        @dragover.prevent="dragOverId = device.id"
        @dragleave="onDragLeave(device.id, $event)"
        @drop.prevent="onDrop(device.id)"
      >
        <div class="tile-header">
          <span
            class="tile-drag"
            draggable="true"
            title="拖动排序"
            @dragstart="onDragStart(device.id, $event)"
            @dragend="onDragEnd"
          >
            <n-icon :size="wallZoom < 0.7 ? 11 : 14"><ReorderTwoOutline /></n-icon>
          </span>
          <span class="tile-name" :title="device.name">{{ device.name }}</span>
          <n-tag
            v-if="linkEnabled"
            size="tiny"
            :type="linkPaused ? 'warning' : 'success'"
            :bordered="false"
          >
            {{ linkPaused ? '已解除' : '联动' }}
          </n-tag>
          <n-tag
            v-if="controllers[device.id] === false"
            size="tiny"
            type="warning"
            :bordered="false"
          >
            仅查看
          </n-tag>
          <span v-if="wallZoom >= 0.7" class="tile-meta">
            {{ device.platform === 'ios' ? 'iOS' : 'Android' }}
            {{ device.osVersion ?? '' }}
          </span>
          <button
            type="button"
            class="tile-remove"
            title="移除"
            @click="removeDevice(device.id)"
          >
            <n-icon :size="wallZoom < 0.7 ? 11 : 14"><CloseOutline /></n-icon>
          </button>
        </div>
        <div class="tile-stage">
          <DevicePlayer
            v-if="
              sessions[device.id] ||
              (device.platform === 'ios' && device.agentId === BUILTIN_AGENT_ID)
            "
            :key="`${device.id}-${sessions[device.id] ?? 'ios'}-${quality}`"
            :ref="(el) => setPlayerRef(device.id, el)"
            :session-id="sessions[device.id] ?? ''"
            :platform="device.platform"
            :device-id="device.id"
            :quality="quality"
            :control-allowed="controllers[device.id] ?? true"
            flush
            @controller-change="onControllerChange(device.id, $event)"
            @input="onInput(device.id, $event)"
          />
          <div v-else class="tile-loading">
            {{
              codecBlocked
                ? '无法解码，请用 localhost 或 HTTPS 打开'
                : connecting[device.id]
                  ? '连接中…'
                  : '等待连接'
            }}
          </div>
        </div>
      </section>
    </TransitionGroup>

    <n-empty
      v-else
      class="batch-empty"
      description="点击右上角「添加设备」开始批量控制"
    />

    <Transition name="chat-panel">
      <section v-if="chatOpen" class="ai-chat-panel">
        <header class="ai-chat-head">
          <div class="ai-chat-title">
            <n-icon :size="18"><SparklesOutline /></n-icon>
            <div>
              <strong>AI 批量助手</strong>
              <span>{{
                selectedDevices.length > 0
                  ? `${selectedDevices.length} 台已选设备`
                  : '未选设备，默认全部在线设备'
              }}</span>
            </div>
          </div>
          <button
            type="button"
            class="ai-chat-close"
            title="收起"
            @click="chatOpen = false"
          >
            <n-icon :size="18"><CloseOutline /></n-icon>
          </button>
        </header>

        <div ref="chatScrollRef" class="ai-chat-body">
          <div
            v-for="item in chatMessages"
            :key="item.id"
            class="chat-message"
            :class="item.role"
          >
            <div class="chat-bubble" :class="{ error: item.error }">
              <div class="chat-text">{{ item.content }}</div>
              <div v-if="item.tasks.length > 0" class="chat-tasks">
                <div
                  v-for="task in item.tasks"
                  :key="task.id"
                  class="chat-task"
                >
                  <div class="chat-task-head">
                    <span class="chat-task-device">
                      {{ deviceName(task.deviceId) }}
                    </span>
                    <n-tag
                      size="tiny"
                      :type="taskStatusType(task.status)"
                      :bordered="false"
                    >
                      {{ taskStatusLabel(task.status) }}
                    </n-tag>
                  </div>
                  <div class="chat-task-instruction">
                    {{ task.instruction }}
                  </div>
                  <div v-if="task.error" class="chat-task-detail error">
                    {{ task.error }}
                  </div>
                  <div v-else-if="task.reply" class="chat-task-detail">
                    {{ task.reply }}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="chatBusy" class="chat-typing">AI 正在理解你的指令…</div>
        </div>

        <footer class="ai-chat-input">
          <n-input
            v-model:value="chatInput"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="例如：所有设备一起打开设置；或让 Redmi 发消息给 iPhone"
            @keydown.enter="onChatEnter"
            @compositionstart="onChatCompositionStart"
            @compositionend="onChatCompositionEnd"
          />
          <n-button
            type="primary"
            circle
            :loading="chatBusy"
            :disabled="chatBusy || !chatInput.trim()"
            @click="sendChat"
          >
            <template #icon>
              <n-icon><ArrowUpOutline /></n-icon>
            </template>
          </n-button>
        </footer>
      </section>
    </Transition>

    <button
      v-if="!chatOpen"
      type="button"
      class="ai-fab"
      title="打开 AI 批量助手"
      @click="toggleChat"
    >
      <n-icon :size="20"><SparklesOutline /></n-icon>
      <span>AI 批量</span>
    </button>

    <BulkInstallModal
      v-model:show="installShow"
      :devices="installTargets"
    />

    <AddBatchDevicesModal
      v-model:show="addShow"
      :devices="controlDevices"
      :selected="selectedIds"
      @add="addDevices"
    />
  </div>
</template>

<style scoped>
.batch-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
}

.batch-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-group.right {
  margin-left: auto;
}

.tool-divider {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--border);
}

.batch-count {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 11px;
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

.link-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.quality-select {
  width: 104px;
  flex: none;
}

.link-hint {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

.link-hint.paused {
  color: #d97706;
}

.wall-zoom {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}

.wall-zoom button {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.wall-zoom button:hover {
  background: var(--surface);
  color: var(--text);
}

.wall-zoom span {
  min-width: 34px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.wall-zoom .wall-zoom-reset {
  width: auto;
  padding: 0 6px;
  font-size: 10px;
}

/* 右下角固定入口 + ChatGPT 风格对话框 */
.ai-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border: none;
  border-radius: 999px;
  background: #18181b;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.ai-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.26);
}

.ai-chat-panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 61;
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 24px));
  height: min(640px, calc(100vh - 48px));
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.24);
}

.ai-chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
}

.ai-chat-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: var(--text);
}

.ai-chat-title > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ai-chat-title strong {
  font-size: 13px;
  font-weight: 600;
}

.ai-chat-title span {
  font-size: 11px;
  color: var(--text-faint);
}

.ai-chat-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}

.ai-chat-close:hover {
  background: var(--surface-2);
  color: var(--text);
}

.ai-chat-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding: 16px;
  background: var(--surface-2);
}

.chat-message {
  display: flex;
}

.chat-message.user {
  justify-content: flex-end;
}

.chat-bubble {
  max-width: 90%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  border-bottom-left-radius: 4px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.chat-message.user .chat-bubble {
  border-color: #18181b;
  border-radius: 14px;
  border-bottom-right-radius: 4px;
  background: #18181b;
  color: #fff;
}

.chat-bubble.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}

.chat-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-tasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.chat-task {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--text);
}

.chat-task-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-task-device {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-task-instruction {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-task-detail {
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-task-detail.error {
  color: #dc2626;
}

.chat-typing {
  padding-left: 2px;
  color: var(--text-faint);
  font-size: 11px;
}

.ai-chat-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.ai-chat-input .n-input {
  flex: 1;
  min-width: 0;
}

.chat-panel-enter-active,
.chat-panel-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.chat-panel-enter-from,
.chat-panel-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.batch-grid {
  --wall-zoom: 0.5;
  display: grid;
  grid-template-columns:
    repeat(
      auto-fill,
      minmax(
        calc(280px * var(--wall-zoom)),
        calc(360px * var(--wall-zoom))
      )
    );
  justify-content: start;
  align-items: start;
  gap: calc(10px * var(--wall-zoom));
}

.tile {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.2s ease;
}

.tile.dragging {
  opacity: 0.45;
}

.tile.drag-over {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
}

/* 排序后卡片平滑移动到新位置 */
.tile-move {
  transition: transform 0.28s cubic-bezier(0.2, 0, 0, 1);
}

.tile-enter-active,
.tile-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.tile-enter-from,
.tile-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

.tile-drag {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  cursor: grab;
}

.tile-drag:active {
  cursor: grabbing;
}

.tile-drag:hover {
  color: var(--text);
}

.tile-header {
  display: flex;
  align-items: center;
  gap: clamp(3px, calc(6px * var(--wall-zoom)), 8px);
  min-height: clamp(22px, calc(30px * var(--wall-zoom)), 34px);
  padding: clamp(2px, calc(5px * var(--wall-zoom)), 8px)
    clamp(5px, calc(9px * var(--wall-zoom)), 12px);
  border-bottom: 1px solid var(--border);
}

/* 10%~29% 只保留画面，标题栏会占满整个缩略图 */
.tile.micro .tile-header {
  display: none;
}

.tile-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: clamp(9px, calc(12px * var(--wall-zoom)), 12px);
  font-weight: 500;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-header :deep(.n-tag) {
  flex: none;
  height: auto;
  padding: 0 4px;
  font-size: clamp(8px, calc(10px * var(--wall-zoom)), 10px);
  line-height: 1.5;
}

.tile-meta {
  flex: none;
  margin-left: auto;
  font-size: clamp(8px, calc(10px * var(--wall-zoom)), 10px);
  color: var(--text-faint);
  white-space: nowrap;
}

.tile-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: clamp(16px, calc(22px * var(--wall-zoom)), 22px);
  height: clamp(16px, calc(22px * var(--wall-zoom)), 22px);
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}

.tile-remove:hover {
  background: var(--surface-2);
  color: var(--text);
}

.tile-stage {
  position: relative;
  width: 100%;
  aspect-ratio: var(--tile-ratio, 9 / 19.5);
  background: #000;
}

.tile-loading {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 12px;
  color: #71717a;
}

.batch-empty {
  padding: 60px 0;
}

/* WebCodecs 不可用（http + 局域网 IP）时的说明 */
.codec-alert {
  margin: 0 20px 12px;
}

.codec-alert .codec-hints {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
}

</style>






