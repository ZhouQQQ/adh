<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NIcon,
  NInput,
  NSelect,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import { ArrowBackOutline, CloudOfflineOutline } from '@vicons/ionicons5';
import DeviceFileBrowser from '../components/DeviceFileBrowser.vue';
import DevicePlayer from '../components/DevicePlayer.vue';
import DeviceAppsDrawer from '../components/DeviceAppsDrawer.vue';
import DeviceStats from '../components/DeviceStats.vue';
import InstallAppModal from '../components/InstallAppModal.vue';
import SafeKeyboardOverlay from '../components/SafeKeyboardOverlay.vue';
import CopyValue from '../components/CopyValue.vue';
import type { SafeKeyboardLayout } from '@adh/protocol';
import { api } from '../api';
import { stopFleet, useFleet } from '../stores/fleet';
import { useAuth } from '../stores/auth';
import { usePreviews } from '../stores/previews';
import { openDevicePip, supportsDocumentPip } from '../utils/document-pip';
import { fileTimestamp, safeFileName, saveBlob } from '../utils/download';
import {
  formatDateTime,
  formatMemory,
  formatResolution,
  formatDuration,
} from '../utils/format';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { devices, agents, refresh } = useFleet();
const { user, isAdmin, logout } = useAuth();

const roleLabel = computed(() =>
  user.value?.role === 'admin' ? '管理员' : '操作员',
);

async function handleLogout(): Promise<void> {
  stopFleet();
  await logout();
  await router.replace('/login');
}
const { openPreview, closePreview, previews } = usePreviews();

const playerRef = ref<InstanceType<typeof DevicePlayer> | null>(null);
const sessionId = ref<string | null>(null);
const loading = ref(false);
const errorText = ref<string | null>(null);
const controller = ref(false);
const text = ref('');
const fileShow = ref(false);
const appsShow = ref(false);
const installShow = ref(false);
const stageRef = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const recording = ref(false);

async function toggleFullscreen(): Promise<void> {
  const element = stageRef.value;
  if (!element) return;
  try {
    if (!document.fullscreenElement) {
      await element.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    message.error('当前浏览器不允许全屏');
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === stageRef.value;
}

const deviceId = computed(() => String(route.params.id ?? ''));
const device = computed(
  () => devices.value.find((item) => item.id === deviceId.value) ?? null,
);

watch(
  () => device.value?.name,
  (name) => {
    document.title = name ? `${name} · 设备控制` : '设备控制 · ADH';
  },
  { immediate: true },
);

const agentName = computed(() => {
  const current = device.value;
  if (!current) return '—';
  return agents.value.find((agent) => agent.id === current.agentId)?.name ?? '未知节点';
});

const resolutionText = computed(() =>
  formatResolution(device.value?.resolution),
);

const osText = computed(() => {
  const current = device.value;
  if (!current?.osVersion) return '—';
  return current.platform === 'ios'
    ? `iOS ${current.osVersion}`
    : `Android ${current.osVersion}`;
});

const memoryText = computed(() => formatMemory(device.value?.memoryMb));

const rootedText = computed(() => {
  const rooted = device.value?.rooted;
  if (rooted === undefined) return '—';
  return rooted ? '已 Root' : '未 Root';
});

const cpuText = computed(() => {
  const current = device.value;
  if (!current?.cpu) return '—';
  return current.cpuCores
    ? `${current.cpu} · ${current.cpuCores} 核`
    : current.cpu;
});

const brandText = computed(() => device.value?.brand ?? '—');

const lastSeenText = computed(() =>
  device.value ? formatDateTime(device.value.lastSeen) : '—',
);

const publishedText = computed(() => {
  const value = device.value?.publishedAt ?? 0;
  if (value <= 0) return '未设置';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
});

const isIos = computed(() => device.value?.platform === 'ios');
const quality = ref<'low' | 'medium' | 'high'>('medium');
const pipActive = ref(false);
let docPip: Window | null = null;
const reloadNonce = ref(0);
const safeKeyboard = ref(false);
const readonlyBannerClosed = ref(false);
const releasedBy = ref('');

function onControlReleased(username: string): void {
  releasedBy.value = username || '控制者';
  readonlyBannerClosed.value = false;
}

const allowViewers = ref(true);

function onViewersAllow(value: boolean): void {
  allowViewers.value = value;
}

async function toggleViewers(value: boolean): Promise<void> {
  const current = device.value;
  if (!current) return;
  try {
    await api.setStreamViewers(current.id, value);
    allowViewers.value = value;
    message.success(value ? '已允许他人查看' : '已关闭他人查看');
  } catch (error) {
    allowViewers.value = !value;
    message.error(error instanceof Error ? error.message : '设置失败');
  }
}

const now = ref(Date.now());
let clockTimer: number | null = null;

const controlName = computed(() =>
  device.value?.control
    ? device.value.control.displayName || device.value.control.username
    : '',
);
const controlDuration = computed(() =>
  device.value?.control
    ? formatDuration(device.value.control.since, now.value)
    : '',
);
const controlSinceText = computed(() =>
  device.value?.control
    ? formatDateTime(device.value.control.since)
    : '',
);
const canKick = computed(
  () =>
    isAdmin.value &&
    Boolean(device.value?.control) &&
    device.value?.control?.userId !== user.value?.id,
);
const canTakeover = computed(() => {
  if (!sessionId.value || controller.value) return false;
  // 控制者主动释放后，任何观看者都能接管；其余情况只有管理员能抢
  if (releasedBy.value) return true;
  return isAdmin.value;
});

async function takeoverControl(): Promise<void> {
  const current = device.value;
  if (!current) return;
  try {
    await api.takeoverDeviceStream(current.id);
    message.success('已接管控制权');
    releasedBy.value = '';
    await refresh();
  } catch (error) {
    message.warning(
      error instanceof Error ? error.message : '控制权已被其他人接管',
    );
    releasedBy.value = '';
    await refresh();
  }
}

async function stopControl(): Promise<void> {
  const current = device.value;
  if (!current) return;
  try {
    await api.stopDeviceStream(current.id);
  } catch {
    /* 会话可能已经结束 */
  }
  await goBack();
}

watch(controller, (value, previous) => {
  if (value) readonlyBannerClosed.value = false;
  if (!value) safeKeyboard.value = false;
  if (previous === true && value === false) {
    message.warning('控制权已被接管，你现在是只读');
  }
});

async function kickControl(): Promise<void> {
  const current = device.value;
  if (!current) return;
  try {
    await api.kickDeviceStream(current.id);
    message.success('已强制断开');
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '断开失败');
  }
}

/** 安全键盘位置存服务端，多人共享。 */
function saveSafeKeyboard(layout: SafeKeyboardLayout): void {
  const id = device.value?.id;
  if (!id) return;
  void api
    .updateDevice(id, { safeKeyboard: layout })
    .then((updated) => {
      const cached = devices.value.find((item) => item.id === id);
      if (cached) cached.safeKeyboard = updated.safeKeyboard;
    })
    .catch(() => undefined);
}

function toggleSafeKeyboard(): void {
  safeKeyboard.value = !safeKeyboard.value;
  // 打开时拉一次最新布局，别人调过的也能同步
  if (safeKeyboard.value) void refresh();
}

watch(previews, (list) => {
  const id = device.value?.id;
  // 仅页面内浮窗被关掉时才复位；Document PiP 不经过 previews
  if (docPip) return;
  if (pipActive.value && id && !list.some((item) => item.deviceId === id)) {
    pipActive.value = false;
  }
});

async function onQualityChange(
  value: 'low' | 'medium' | 'high',
): Promise<void> {
  quality.value = value;

  // iOS 由 DevicePlayer 重新挂载后按新档位拉流
  if (isIos.value || !device.value) return;

  loading.value = true;
  errorText.value = null;
  try {
    const result = await api.restartStream(device.value.id, value);
    sessionId.value = result.sessionId;
  } catch (error) {
    errorText.value =
      error instanceof Error ? error.message : '无法切换画质';
  } finally {
    loading.value = false;
  }
}

async function createSession(): Promise<void> {
  if (!device.value) return;

  // iOS 走 WDA，没有 scrcpy 会话
  if (device.value.platform === 'ios') {
    sessionId.value = null;
    errorText.value = null;
    loading.value = false;
    controller.value = true;
    return;
  }

  loading.value = true;
  errorText.value = null;
  sessionId.value = null;
  try {
    const result = await api.createStream(device.value.id, quality.value);
    sessionId.value = result.sessionId;
  } catch (error) {
    errorText.value =
      error instanceof Error ? error.message : '无法建立投屏会话';
  } finally {
    loading.value = false;
  }
}

function requireController(): boolean {
  if (controller.value) return true;
  message.warning('当前为只读模式，无法操作设备');
  return false;
}

function sendKey(
  key:
    | 'home'
    | 'back'
    | 'recent'
    | 'power'
    | 'volumeUp'
    | 'volumeDown'
    | 'mute',
): void {
  if (!requireController()) return;
  playerRef.value?.sendKey(key);
}

function sendText(): void {
  const value = text.value.trim();
  if (!value || !requireController()) return;
  playerRef.value?.sendText(value);
  text.value = '';
}

function deviceFileName(extension: string): string {
  const name = safeFileName(device.value?.name ?? 'device');
  return `${name}-${fileTimestamp()}.${extension}`;
}

function setScreen(on: boolean): void {
  if (!requireController()) return;
  playerRef.value?.setScreen(on);
}

function openNotification(): void {
  if (!requireController()) return;
  playerRef.value?.expandNotification();
}

function openApps(): void {
  appsShow.value = true;
}

async function takeScreenshot(): Promise<void> {
  const blob = await playerRef.value?.screenshot();
  if (!blob) {
    message.warning('画面还没就绪，稍后再试');
    return;
  }
  saveBlob(blob, deviceFileName('png'));
  message.success('截图已保存');
}

/** 把当前画面写进系统剪贴板（需要 HTTPS 或 localhost）。 */
async function copyScreenshot(): Promise<void> {
  const blob = await playerRef.value?.screenshot();
  if (!blob) {
    message.warning('画面还没就绪，稍后再试');
    return;
  }

  if (!window.isSecureContext || !navigator.clipboard?.write) {
    message.warning('当前地址不支持写剪贴板，请改用 localhost 或 HTTPS 访问');
    return;
  }
  if (typeof ClipboardItem === 'undefined') {
    message.warning('当前浏览器不支持图片剪贴板');
    return;
  }

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    message.success('截图已复制到剪贴板');
  } catch {
    message.error('写入剪贴板失败，请检查浏览器权限');
  }
}

async function toggleRecording(): Promise<void> {
  if (!recording.value) {
    const started = playerRef.value?.startRecording();
    if (!started) {
      message.warning('无法开始录制');
      return;
    }
    recording.value = true;
    message.success('开始录制，再次点击结束');
    return;
  }

  const blob = await playerRef.value?.stopRecording();
  recording.value = false;
  if (!blob || blob.size === 0) {
    message.warning('录制内容为空');
    return;
  }
  saveBlob(
    blob,
    deviceFileName(playerRef.value?.recordingExtension() ?? 'webm'),
  );
  message.success('录屏已保存');
}

function onPlayerClosed(): void {
  sessionId.value = null;
  if (!errorText.value) {
    errorText.value = '画面连接已断开，点击重试';
  }
  releasedBy.value = '';
}

async function goBack(): Promise<void> {
  void router.push('/devices');
}

/** 设备断联后手动重连：先刷新设备状态，再重建播放器。 */
async function reconnect(): Promise<void> {
  await refresh();
  const current = device.value;
  if (!current) return;
  if (current.status !== 'online') {
    message.warning('设备仍未上线，请检查 USB 连接和 WDA');
    return;
  }
  errorText.value = null;
  reloadNonce.value += 1;
  await createSession();
}

/** ESC 返回设备列表；输入框或有弹窗/抽屉时交给它们自己处理。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;

  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  ) {
    return;
  }

  if (document.querySelector('.n-modal-mask, .n-drawer-mask, .n-drawer')) {
    return;
  }

  void goBack();
}

/** 打开画中画：优先用 Document PiP（可拖到浏览器外），不支持时用页面内浮窗。 */
async function openSmallWindow(): Promise<void> {
  const current = device.value;
  const player = playerRef.value;
  if (!current || !player) return;

  // 用主画面 canvas 的镜像流，避免二次开流黑屏和抢控制权
  const stream = player.createMirrorStream();
  if (!stream) {
    message.warning('画面还没就绪，稍后再试');
    return;
  }

  if (supportsDocumentPip()) {
    try {
      docPip = await openDevicePip({
        title: current.name,
        platform: current.platform === 'ios' ? 'ios' : 'android',
        stream,
        onTap: (x, y) => player.mirrorTap(x, y),
        onSwipe: (fromX, fromY, toX, toY, duration) =>
          player.mirrorSwipe(fromX, fromY, toX, toY, duration),
        onKey: (key) => player.sendKey(key),
        onClose: () => {
          docPip = null;
          pipActive.value = false;
        },
      });
      if (docPip) {
        pipActive.value = true;
        return;
      }
    } catch {
      /* 用户拒绝或浏览器异常，退回页面内浮窗 */
    }
  }

  openPreview({
    deviceId: current.id,
    deviceName: current.name,
    platform: current.platform === 'ios' ? 'ios' : 'android',
    stream,
    tap: (x, y) => player.mirrorTap(x, y),
    swipe: (fromX, fromY, toX, toY, duration) =>
      player.mirrorSwipe(fromX, fromY, toX, toY, duration),
    home: () => player.sendKey('home'),
    back: () => player.sendKey('back'),
    recent: () => player.sendKey('recent'),
  });
  pipActive.value = true;
}

function closePip(): void {
  if (docPip) {
    docPip.close();
    docPip = null;
  }
  if (device.value) closePreview(device.value.id);
  pipActive.value = false;
}

function togglePip(): void {
  if (pipActive.value) {
    closePip();
    return;
  }
  void openSmallWindow();
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('keydown', onKeydown);
  clockTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  if (devices.value.length === 0) await refresh();
  await createSession();
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  window.removeEventListener('keydown', onKeydown);
  if (clockTimer) window.clearInterval(clockTimer);
  document.title = 'ADH · 设备农场';
  if (document.fullscreenElement === stageRef.value) {
    void document.exitFullscreen();
  }
  // 主画面销毁后镜像流就失效了，同步关掉画中画
  if (pipActive.value) closePip();
  sessionId.value = null;
});
</script>

<template>
  <div class="control-page">
    <header class="toolbar">
      <n-button
        quaternary
        circle
        size="small"
        title="返回设备列表"
        @click="goBack"
      >
        <template #icon>
          <n-icon><ArrowBackOutline /></n-icon>
        </template>
      </n-button>
      <div class="title">{{ device?.name ?? '设备控制' }}</div>
      <n-tag
        v-if="device?.control"
        size="small"
        :bordered="false"
        round
      >
        {{ controlName }} {{ controlSinceText }} 起控制 · 已
        {{ controlDuration }}
      </n-tag>
      <n-button
        v-if="canKick"
        size="tiny"
        type="error"
        ghost
        @click="kickControl"
      >
        强制断开
      </n-button>
      <n-tag
        v-if="sessionId && !controller"
        size="small"
        type="warning"
        :bordered="false"
      >
        只读
      </n-tag>

      <div class="toolbar-right">
        <label
          v-if="controller || isAdmin"
          class="viewers-switch"
          title="关闭后其他人无法查看，管理员不受限制"
        >
          <n-switch
            size="small"
            :value="allowViewers"
            @update:value="toggleViewers"
          />
          <span>允许他人查看</span>
        </label>
        <n-select
          v-model:value="quality"
          size="tiny"
          class="quality-select"
          :disabled="!controller"
          :options="[
            { label: '低画质', value: 'low' },
            { label: '中画质', value: 'medium' },
            { label: '高画质', value: 'high' },
          ]"
          @update:value="onQualityChange"
        />
        <n-button
          v-if="device && device.status !== 'online'"
          size="tiny"
          type="warning"
          ghost
          @click="reconnect"
        >
          重新连接
        </n-button>
        <n-button
          v-if="controller && !isIos"
          size="tiny"
          type="error"
          ghost
          @click="stopControl"
        >
          断开
        </n-button>
        <n-button
          v-if="canTakeover"
          size="tiny"
          type="primary"
          ghost
          @click="takeoverControl"
        >
          接管
        </n-button>
        <div class="toolbar-user">
          <span class="toolbar-user-name">
            {{ user?.displayName || user?.username || '未登录' }}
          </span>
          <n-tag size="tiny" :bordered="false">{{ roleLabel }}</n-tag>
          <n-button text size="tiny" @click="handleLogout">退出</n-button>
        </div>
      </div>
    </header>

    <div class="body">
      <aside class="info-col">
        <div class="section-title stats-title">运行状态</div>
        <DeviceStats :device-id="device?.id ?? ''" />

        <div class="section-title info-title">设备信息</div>
        <div class="info-row">
          <span>名称</span>
          <CopyValue :value="device?.name" />
        </div>
        <div class="info-row">
          <span>品牌</span>
          <CopyValue :value="brandText" />
        </div>
        <div class="info-row">
          <span>系统</span>
          <CopyValue :value="osText" />
        </div>
        <div class="info-row">
          <span>CPU</span>
          <CopyValue :value="cpuText" />
        </div>
        <div class="info-row">
          <span>内存</span>
          <CopyValue :value="memoryText" />
        </div>
        <div class="info-row">
          <span>Root</span>
          <CopyValue :value="rootedText" />
        </div>
        <div class="info-row">
          <span>分辨率</span>
          <CopyValue :value="resolutionText" />
        </div>
        <div class="info-row">
          <span>节点</span>
          <CopyValue :value="agentName" />
        </div>
        <div class="info-row">
          <span>UDID</span>
          <CopyValue :value="device?.udid" mono />
        </div>
        <div class="info-row">
          <span>最后在线</span>
          <CopyValue :value="lastSeenText" />
        </div>
        <div class="info-row">
          <span>发布时间</span>
          <CopyValue :value="publishedText" />
        </div>
        <div class="info-row">
          <span>状态</span>
          <span class="info-status" :class="device?.status">
            {{ device?.status === 'online' ? '在线' : device?.status === 'offline' ? '离线' : '未授权' }}
          </span>
        </div>
      </aside>

      <div ref="stageRef" class="stage">
        <n-spin v-if="loading" :show="true" class="spin" />
        <div
          v-if="sessionId || isIos"
          class="player-shell"
          :class="{ covered: pipActive }"
        >
          <DevicePlayer
            ref="playerRef"
            :key="`${sessionId ?? ''}-${quality}-${reloadNonce}`"
            :session-id="sessionId ?? ''"
            :platform="device?.platform"
            :device-id="device?.id"
            :quality="quality"
            @controller-change="controller = $event"
            @error="errorText = $event"
            @control-released="onControlReleased"
            @viewers-allow="onViewersAllow"
            @closed="onPlayerClosed"
          />
        </div>
        <div v-else class="placeholder">
          <div class="placeholder-icon">
            <n-icon :size="32"><CloudOfflineOutline /></n-icon>
          </div>
          <div class="placeholder-title">画面连接已断开</div>
          <div class="placeholder-desc">
            可能是网络波动，或设备被其他操作占用。<br />
            重新连接会重新建立投屏会话。
          </div>
          <button type="button" class="placeholder-btn" @click="createSession">
            重新连接
          </button>
        </div>

        <div
          v-if="releasedBy && !controller"
          class="readonly-banner released"
        >
          <span>{{ releasedBy }} 已断开，是否接管控制？</span>
          <n-button size="tiny" type="primary" @click="takeoverControl">
            接管
          </n-button>
          <button
            type="button"
            class="banner-close"
            title="关闭提示"
            @click="releasedBy = ''"
          >
            ×
          </button>
        </div>

        <div
          v-if="sessionId && !controller && !readonlyBannerClosed && !releasedBy"
          class="readonly-banner"
        >
          <span>
            {{ controlName }} {{ controlSinceText }} 开始控制，你当前只能查看。
            <template v-if="isAdmin">可以点右上角「接管」继续操作。</template>
          </span>
          <button
            type="button"
            class="banner-close"
            title="关闭提示"
            @click="readonlyBannerClosed = true"
          >
            ×
          </button>
        </div>

        <div v-if="device && device.status !== 'online'" class="offline-overlay">
          <div class="offline-title">设备已离线</div>
          <div class="offline-desc">
            请检查 USB 连接；iOS 还需要确认手机已信任电脑、WDA 正在运行。
          </div>
          <n-button size="small" type="primary" @click="reconnect">
            重新连接
          </n-button>
        </div>

        <div v-if="pipActive" class="pip-notice">
          <div class="pip-title">画面已切换到画中画</div>
          <div class="pip-desc">
            窗口可以拖到浏览器外，点击画面即可操作设备。
          </div>
          <button type="button" class="placeholder-btn" @click="togglePip">
            收回画面
          </button>
        </div>

        <div class="stage-actions">
          <button
            type="button"
            class="overlay-btn"
            :disabled="!controller"
            @click="toggleSafeKeyboard"
          >
            {{ safeKeyboard ? '隐藏键盘' : '安全键盘' }}
          </button>
          <button type="button" class="overlay-btn" @click="togglePip">
            {{ pipActive ? '收回画中画' : '画中画' }}
          </button>
          <button type="button" class="overlay-btn" @click="toggleFullscreen">
            {{ isFullscreen ? '退出全屏' : '全屏' }}
          </button>
        </div>

        <SafeKeyboardOverlay
          :visible="safeKeyboard"
          :device-id="device?.id"
          :layout="device?.safeKeyboard"
          @change="saveSafeKeyboard"
        />

        <div v-if="isFullscreen" class="fullscreen-bar">
          <div class="fs-group">
            <div class="fs-title">导航</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" :disabled="isIos" @click="sendKey('back')">
                返回
              </button>
              <button type="button" class="bar-btn" @click="sendKey('home')">主页</button>
              <button type="button" class="bar-btn" @click="sendKey('recent')">任务</button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">音量</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" @click="sendKey('volumeDown')">音量−</button>
              <button type="button" class="bar-btn" @click="sendKey('volumeUp')">音量+</button>
              <button type="button" class="bar-btn" :disabled="isIos" @click="sendKey('mute')">
                静音
              </button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">屏幕</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" :disabled="isIos" @click="sendKey('power')">
                电源
              </button>
              <button type="button" class="bar-btn" :disabled="isIos" @click="setScreen(false)">
                息屏
              </button>
              <button type="button" class="bar-btn" :disabled="isIos" @click="setScreen(true)">
                亮屏
              </button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">抓取</div>
            <div class="fs-grid cols-2">
              <button type="button" class="bar-btn" @click="copyScreenshot">
                复制截图
              </button>
              <button type="button" class="bar-btn" @click="takeScreenshot">截图保存</button>
              <button type="button" class="bar-btn span-2" @click="toggleRecording">
                {{ recording ? '停止' : '录屏' }}
              </button>
            </div>
          </div>

          <div class="fs-grid">
            <button type="button" class="bar-btn wide" @click="toggleFullscreen">
              退出全屏
            </button>
          </div>
        </div>
      </div>

      <aside class="side" :class="{ readonly: !controller }">
        <section class="section">
          <div class="section-title">导航</div>
          <div class="grid-3">
            <n-button size="small" :disabled="isIos" @click="sendKey('back')">
              返回
            </n-button>
            <n-button size="small" @click="sendKey('home')">主页</n-button>
            <n-button size="small" @click="sendKey('recent')">任务</n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">音量</div>
          <div class="grid-3">
            <n-button size="small" @click="sendKey('volumeDown')">音量−</n-button>
            <n-button size="small" @click="sendKey('volumeUp')">音量+</n-button>
            <n-button size="small" :disabled="isIos" @click="sendKey('mute')">
              静音
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">设备</div>
          <div class="grid-3">
            <n-button size="small" :disabled="isIos" @click="sendKey('power')">
              电源
            </n-button>
            <n-button size="small" :disabled="isIos" @click="setScreen(false)">
              息屏
            </n-button>
            <n-button size="small" :disabled="isIos" @click="setScreen(true)">
              亮屏
            </n-button>
          </div>
          <div class="grid-2">
            <n-button size="small" :disabled="isIos" @click="fileShow = true">
              文件管理
            </n-button>
            <n-button size="small" :disabled="isIos" @click="openNotification">
              通知栏
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">抓取</div>
          <div class="grid-2">
            <n-button size="small" title="截图到剪贴板" @click="copyScreenshot">
              复制截图
            </n-button>
            <n-button size="small" @click="takeScreenshot">截图保存</n-button>
          </div>
          <n-button size="small" block @click="toggleRecording">
            {{ recording ? '停止' : '录屏' }}
          </n-button>
        </section>

        <section class="section">
          <div class="section-title">应用</div>
          <div class="grid-2">
            <n-button size="small" @click="installShow = true">
              安装应用
            </n-button>
            <n-button size="small" @click="openApps">
              应用管理
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">文本输入</div>
          <n-input
            v-model:value="text"
            type="textarea"
            size="small"
            :rows="3"
            placeholder="输入文字后发送到设备"
            :disabled="!controller"
            @keyup.ctrl.enter="sendText"
          />
          <n-button
            size="small"
            type="primary"
            block
            :disabled="!controller"
            @click="sendText"
          >
            发送到设备
          </n-button>
        </section>
      </aside>
    </div>

    <DeviceFileBrowser
      v-model:show="fileShow"
      :device-id="device?.id ?? ''"
      :device-name="device?.name ?? ''"
    />
    <DeviceAppsDrawer
      v-model:show="appsShow"
      :device-id="device?.id ?? ''"
      :device-name="device?.name ?? ''"
      :platform="device?.platform"
    />
    <InstallAppModal
      v-model:show="installShow"
      :device-id="device?.id ?? ''"
      :device-name="device?.name ?? ''"
      :platform="device?.platform ?? 'android'"
    />
  </div>
</template>

<style scoped>
.control-page {
  /* 不依赖父级高度链，避免 n-layout-content 内部 wrapper 不传递高度导致画面塌陷 */
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  flex: none;
}

.toolbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
}

.toolbar-user {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
}

.toolbar-user-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-dim);
}

.title {
  font-size: 13px;
  font-weight: 600;
}

.quality-select {
  width: 96px;
}

.viewers-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}

.meta {
  margin-left: auto;
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-faint);
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 14px;
  padding: 14px;
}

.info-col {
  width: 216px;
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow-y: auto;
}

.info-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.info-row > span:first-child {
  font-size: 10px;
  color: var(--text-faint);
}

.info-row :deep(.copy-value) {
  font-size: 12px;
  color: var(--text-muted);
}

.info-status {
  font-size: 12px;
}

.info-status.online {
  color: #16a34a;
}

.info-status.offline {
  color: var(--text-faint);
}

.info-status.unauthorized {
  color: #d97706;
}

.stage {
  flex: 1;
  min-width: 0;
  min-height: 240px;
  position: relative;
  background: #0b0b0d;
  border-radius: 10px;
  overflow: hidden;
}

.player-shell {
  position: absolute;
  inset: 0;
}

/* 画中画开启时保留组件与 canvas（镜像流不断），只是隐藏 */
.player-shell.covered {
  visibility: hidden;
  pointer-events: none;
}

.pip-notice {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #d4d4d8;
  text-align: center;
}

.pip-title {
  font-size: 14px;
  font-weight: 600;
  color: #fafafa;
}

.pip-desc {
  font-size: 12px;
  color: #a1a1aa;
}

.pip-notice .placeholder-btn {
  margin-top: 6px;
}

.spin {
  margin: auto;
}

.stage-actions {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 10;
  display: flex;
  gap: 6px;
}

.overlay-btn {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(10, 10, 11, 0.6);
  color: #fafafa;
  font-size: 12px;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background-color 0.15s ease;
}

.overlay-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}

.overlay-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.overlay-btn:disabled:hover {
  background: rgba(10, 10, 11, 0.6);
}

.stage:fullscreen .stage-actions {
  display: none;
}

.fullscreen-bar {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 216px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(10, 10, 11, 0.85);
  backdrop-filter: blur(12px);
  z-index: 10;
}

.fs-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fs-title {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.5);
}

.fs-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.fs-grid.cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.bar-btn {
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.08);
  color: #fafafa;
  font-size: 12px;
  text-align: center;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.bar-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}

.bar-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.bar-btn:disabled:hover {
  background: rgba(255, 255, 255, 0.08);
}

.bar-btn.wide {
  grid-column: span 3;
}

.bar-btn.span-2 {
  grid-column: span 2;
}

.bar-divider {
  width: 100%;
  height: 1px;
  background: rgba(255, 255, 255, 0.14);
}

.stage:fullscreen {
  width: 100vw;
  height: 100vh;
  max-height: none;
  border-radius: 0;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  padding: 32px 24px;
  text-align: center;
}

.placeholder-icon {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  margin-bottom: 2px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #71717a;
}

.placeholder-title {
  font-size: 14px;
  font-weight: 500;
  color: #e4e4e7;
}

.placeholder-desc {
  max-width: 320px;
  font-size: 12px;
  line-height: 1.7;
  color: #71717a;
}

.placeholder-btn {
  margin-top: 8px;
  padding: 7px 20px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: #fafafa;
  color: #09090b;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    transform 0.15s ease;
}

.placeholder-btn:hover {
  background: #e4e4e7;
}

.placeholder-btn:active {
  transform: scale(0.98);
}

.readonly-banner {
  position: absolute;
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
  z-index: 11;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 72%;
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  background: rgba(217, 119, 6, 0.92);
  color: #fff;
  font-size: 12px;
  text-align: center;
}

.banner-close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.readonly-banner.released {
  background: rgba(37, 99, 235, 0.94);
}

.offline-overlay {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  background: rgba(9, 9, 11, 0.78);
  color: #e4e4e7;
  text-align: center;
}

.offline-title {
  font-size: 14px;
  font-weight: 600;
}

.offline-desc {
  max-width: 360px;
  font-size: 12px;
  color: #a1a1aa;
}

.banner-close:hover {
  background: rgba(255, 255, 255, 0.34);
}

.side.readonly {
  opacity: 0.5;
  pointer-events: none;
}

.side {
  width: 200px;
  flex: none;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  background: var(--surface);
}

.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rec-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: #dc2626;
  vertical-align: middle;
  animation: rec-pulse 1.2s ease-in-out infinite;
}

@keyframes rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.section-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-title.stats-title {
  margin-bottom: 8px;
}

.section-title.info-title {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-bottom: 8px;
}

.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

@media (max-width: 1200px) {
  .info-col {
    display: none;
  }
}

@media (max-width: 900px) {
  .body {
    flex-direction: column;
    padding: 10px;
    gap: 10px;
  }

  .side {
    width: 100%;
    border: 1px solid var(--border);
    flex-direction: row;
    flex-wrap: wrap;
    gap: 12px;
    max-height: 40vh;
  }

  .section {
    min-width: 180px;
  }
}
</style>