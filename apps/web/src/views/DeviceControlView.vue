<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NDropdown,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  type DropdownOption,
  useMessage,
} from 'naive-ui';
import {
  AlbumsOutline,
  AppsOutline,
  ArrowBackOutline,
  BrowsersOutline,
  CameraOutline,
  CloudDownloadOutline,
  CloudOfflineOutline,
  CloseCircleOutline,
  CopyOutline,
  EllipsisVerticalOutline,
  ExpandOutline,
  FolderOpenOutline,
  HomeOutline,
  KeypadOutline,
  LockClosedOutline,
  LockOpenOutline,
  MoonOutline,
  NotificationsOutline,
  PaperPlaneOutline,
  PersonCircleOutline,
  PowerOutline,
  RefreshOutline,
  ScanOutline,
  StopCircleOutline,
  SunnyOutline,
  SwapHorizontalOutline,
  VideocamOutline,
  VolumeHighOutline,
  VolumeLowOutline,
  VolumeMuteOutline,
} from '@vicons/ionicons5';
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

const roleLabel = computed(() => {
  const role = user.value?.role;
  if (role === 'superadmin') return '超级管理员';
  return role === 'admin' ? '管理员' : '普通用户';
});

async function handleLogout(): Promise<void> {
  stopFleet();
  await logout();
  await router.replace('/login');
}

const pwdShow = ref(false);
const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const pwdSaving = ref(false);

const userMenu = computed<DropdownOption[]>(() => [
  { label: '修改密码', key: 'password' },
  { type: 'divider', key: 'divider' },
  { label: '退出登录', key: 'logout' },
]);

function onUserMenu(key: string): void {
  if (key === 'password') {
    oldPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    pwdShow.value = true;
    return;
  }
  if (key === 'logout') void handleLogout();
}

async function submitPassword(): Promise<void> {
  if (!oldPassword.value) {
    message.warning('请输入原密码');
    return;
  }
  if (newPassword.value.length < 6) {
    message.warning('新密码至少 6 位');
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    message.warning('两次输入的新密码不一致');
    return;
  }

  pwdSaving.value = true;
  try {
    await api.changePassword(oldPassword.value, newPassword.value);
    message.success('密码已修改');
    pwdShow.value = false;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '修改失败');
  } finally {
    pwdSaving.value = false;
  }
}

const { openPreview, closePreview, previews } = usePreviews();

const playerRef = ref<InstanceType<typeof DevicePlayer> | null>(null);
const sessionId = ref<string | null>(null);
const loading = ref(true);
const errorText = ref<string | null>(null);
const viewerClosed = computed(() =>
  Boolean(errorText.value?.includes('关闭其他人查看')),
);
const controller = ref(false);
const text = ref('');
const fileShow = ref(false);
const appsShow = ref(false);
const installShow = ref(false);
const stageRef = ref<HTMLElement | null>(null);
const pageRef = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const isWebFullscreen = ref(false);
const recording = ref(false);

async function toggleFullscreen(): Promise<void> {
  // 浏览器原生全屏：只放大画面，操作使用全屏专用操作列
  const element = stageRef.value;
  if (!element) return;
  try {
    if (!document.fullscreenElement) {
      // 两种全屏互斥，避免布局叠加
      isWebFullscreen.value = false;
      await element.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    message.error('当前浏览器不允许全屏');
  }
}

/** 网页全屏：页面内铺满，保留顶部工具栏和右侧原始操作列。 */
function toggleWebFullscreen(): void {
  isWebFullscreen.value = !isWebFullscreen.value;
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
/** iOS 端不支持的操作统一提示。 */
const iosTip = 'iOS 暂不支持该操作';
const quality = ref<'low' | 'medium' | 'high' | 'ultra'>('medium');
const pipActive = ref(false);
let docPip: Window | null = null;
const reloadNonce = ref(0);
const safeKeyboard = ref(false);
const readonlyBannerClosed = ref(false);
const releasedBy = ref('');

function onControlReleased(username: string): void {
  // 自己主动断开：页面保持只读，不弹接管提示
  if (username && username === user.value?.username) {
    releasedBy.value = '';
    readonlyBannerClosed.value = false;
    message.success('已断开控制，当前页面保持只读');
    return;
  }
  releasedBy.value = username || '控制者';
  readonlyBannerClosed.value = false;
}

const allowViewers = ref(true);

const playerReady = ref(false);

watch([sessionId, quality, reloadNonce], () => {
  playerReady.value = false;
});

/** 设备被锁定后，任何人都不能控制或查看，只有管理员能解锁。 */
const lockedBlocked = computed(() => Boolean(device.value?.locked));

/** 首次进入 / 重连时显示「正在连接」，不要一上来就提示断开。 */
const connecting = computed(
  () =>
    loading.value ||
    (!sessionId.value && !isIos.value && !errorText.value && !lockedBlocked.value),
);

const moreOptions = computed<DropdownOption[]>(() => [
  {
    label: device.value?.locked ? '解除锁定' : '锁定设备',
    key: 'lock',
    icon: () =>
      h(NIcon, null, {
        default: () =>
          h(device.value?.locked ? LockOpenOutline : LockClosedOutline),
      }),
  },
]);

async function onMoreSelect(key: string): Promise<void> {
  if (key !== 'lock') return;
  const current = device.value;
  if (!current) return;

  const next = !current.locked;
  try {
    await api.updateDevice(current.id, { locked: next });
    message.success(next ? '已锁定设备，其他人不能控制或查看' : '已解除锁定');
    await refresh();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败');
  }
}

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

/** 自己主动断开时置 true，watch 里不再提示「被接管」。 */
let selfReleased = false;
/** iOS 控制权心跳：90 秒没有心跳服务端会自动释放。 */
let iosHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

function stopIosHeartbeat(): void {
  if (iosHeartbeatTimer) {
    clearInterval(iosHeartbeatTimer);
    iosHeartbeatTimer = null;
  }
}

function startIosHeartbeat(): void {
  stopIosHeartbeat();
  iosHeartbeatTimer = setInterval(() => {
    const id = device.value?.id;
    if (!id || !isIos.value || !controller.value) return;
    void api
      .heartbeatIosControl(id)
      .then((result) => {
        if (result.ok) return;
        // 控制权被管理员接管或超时释放
        stopIosHeartbeat();
        selfReleased = true;
        controller.value = false;
        releasedBy.value = '控制权已释放';
        readonlyBannerClosed.value = false;
      })
      .catch(() => undefined);
  }, 30_000);
}

async function stopControl(): Promise<void> {
  const current = device.value;
  if (!current) return;

  // iOS 没有服务端投屏会话，断开就是释放控制权，画面保留为只读
  if (isIos.value) {
    stopIosHeartbeat();
    selfReleased = true;
    try {
      await api.stopDeviceStream(current.id);
    } catch {
      /* 控制权可能已经超时释放 */
    }
    controller.value = false;
    readonlyBannerClosed.value = false;
    message.success('已断开控制，当前页面保持只读');
    return;
  }

  try {
    await api.stopDeviceStream(current.id);
  } catch (error) {
    /* 会话可能已经结束 */
    message.warning(error instanceof Error ? error.message : '断开失败');
  }
  // 断开后停留在当前页面，转为只读观看
  await refresh();
}

watch(controller, (value, previous) => {
  if (value) readonlyBannerClosed.value = false;
  if (!value) safeKeyboard.value = false;
  if (previous === true && value === false && !selfReleased) {
    message.warning('控制权已被接管，你现在是只读');
  }
  selfReleased = false;
});

/** iOS 断开后重新申请控制权。 */
async function resumeIosControl(): Promise<void> {
  if (!isIos.value || !device.value) return;
  try {
    const result = await api.claimIosControl(device.value.id);
    if (!result.granted) {
      releasedBy.value = result.control?.username ?? '其他用户';
      readonlyBannerClosed.value = false;
      message.warning(`${releasedBy.value} 正在控制，当前只能查看`);
      return;
    }
    controller.value = true;
    startIosHeartbeat();
  } catch (error) {
    message.warning(
      error instanceof Error ? error.message : '无法获取控制权',
    );
  }
}

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
  value: 'low' | 'medium' | 'high' | 'ultra',
): Promise<void> {
  quality.value = value;

  // iOS 直接改 WDA 的 MJPEG 参数，不断流，下一次请求就按新画质输出
  if (isIos.value) {
    if (device.value) {
      try {
        await api.setIosQuality(device.value.id, value);
      } catch {
        /* 旧版 WDA 不支持时保持原画质 */
      }
    }
    return;
  }

  if (!device.value) return;

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

  // 被管理员锁定时，普通用户直接停在提示页，不发请求
  if (lockedBlocked.value) {
    loading.value = false;
    sessionId.value = null;
    errorText.value = '设备已被管理员锁定';
    return;
  }

  // iOS 走 WDA，没有 scrcpy 会话，但要向服务端申请控制权
  if (device.value.platform === 'ios') {
    sessionId.value = null;
    errorText.value = null;
    loading.value = false;
    try {
      const result = await api.claimIosControl(device.value.id);
      controller.value = result.granted;
      if (result.granted) {
        startIosHeartbeat();
      } else {
        releasedBy.value = result.control?.username ?? '其他用户';
        readonlyBannerClosed.value = false;
      }
    } catch (error) {
      controller.value = false;
      errorText.value =
        error instanceof Error ? error.message : '无法获取控制权';
    }
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
    message.warning(errorText.value);
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

/** 把文本复制到设备剪贴板（不自动粘贴）。 */
function copyToDeviceClipboard(): void {
  const value = text.value.trim();
  if (!value) {
    message.warning('请先输入要复制的内容');
    return;
  }
  if (!requireController()) return;
  playerRef.value?.sendClipboard(value);
  message.success('已复制到设备剪贴板');
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
  playerReady.value = false;
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

  // 网页全屏下按 Esc 先退出全屏，不直接离开页面
  if (isWebFullscreen.value) {
    isWebFullscreen.value = false;
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
  }, 1_000);
  if (devices.value.length === 0) await refresh();
  // iOS 走 MJPEG，截图+编码开销大，默认用低画质保证流畅
  if (device.value?.platform === 'ios') quality.value = 'low';
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
  // iOS 离开页面时释放控制权，其他人可以立即接管
  stopIosHeartbeat();
  if (isIos.value && controller.value) {
    const id = device.value?.id;
    if (id) void api.stopDeviceStream(id).catch(() => undefined);
  }
  sessionId.value = null;
});
</script>

<template>
  <div
    ref="pageRef"
    class="control-page"
    :class="{ 'web-fullscreen': isWebFullscreen }"
  >
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
        v-if="device?.locked"
        size="small"
        type="warning"
        :bordered="false"
        round
      >
        已锁定
      </n-tag>
      <n-tag
        v-if="device?.control"
        size="small"
        :bordered="false"
        round
      >
        {{ controlName }} {{ controlSinceText }} 起控制 · 已
        {{ controlDuration }}
      </n-tag>
      <n-tag
        v-if="sessionId && !controller"
        size="small"
        type="warning"
        :bordered="false"
      >
        只读
      </n-tag>

      <div class="toolbar-center">
        <label
          v-if="controller || isAdmin"
          class="viewers-switch"
          title="关闭后其他人无法查看"
        >
          <span>允许他人查看</span>
          <n-switch
            size="small"
            :value="allowViewers"
            :disabled="!controller"
            @update:value="toggleViewers"
          />
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
            { label: '极高画质', value: 'ultra' },
          ]"
          @update:value="onQualityChange"
        />
      </div>

      <div class="toolbar-right">
        <n-button
          v-if="device && device.status !== 'online'"
          size="tiny"
          type="warning"
          ghost
          @click="reconnect"
        >
          <template #icon>
            <n-icon><RefreshOutline /></n-icon>
          </template>
          重新连接
        </n-button>
        <n-button
          v-if="isIos && !controller"
          size="tiny"
          type="primary"
          ghost
          @click="resumeIosControl"
        >
          <template #icon>
            <n-icon><SwapHorizontalOutline /></n-icon>
          </template>
          重新接管
        </n-button>
        <n-button
          v-if="controller"
          size="tiny"
          type="error"
          ghost
          :disabled="!controller"
          @click="stopControl"
        >
          <template #icon>
            <n-icon><CloseCircleOutline /></n-icon>
          </template>
          断开
        </n-button>
        <n-button
          v-if="canKick"
          size="tiny"
          type="error"
          ghost
          @click="kickControl"
        >
          <template #icon>
            <n-icon><CloseCircleOutline /></n-icon>
          </template>
          断开
        </n-button>
        <n-button
          v-if="canTakeover"
          size="tiny"
          type="primary"
          ghost
          @click="takeoverControl"
        >
          <template #icon>
            <n-icon><SwapHorizontalOutline /></n-icon>
          </template>
          强制接管
        </n-button>
        <n-dropdown
          v-if="isAdmin"
          trigger="click"
          placement="bottom-end"
          :options="moreOptions"
          @select="onMoreSelect"
        >
          <n-button tertiary circle size="small" title="更多操作">
            <template #icon>
              <n-icon><EllipsisVerticalOutline /></n-icon>
            </template>
          </n-button>
        </n-dropdown>
        <n-dropdown
          trigger="click"
          placement="bottom-end"
          :options="userMenu"
          @select="onUserMenu"
        >
          <div class="toolbar-user" role="button" tabindex="0">
            <n-icon class="toolbar-user-icon" :size="16">
              <PersonCircleOutline />
            </n-icon>
            <span class="toolbar-user-name">
              {{ user?.displayName || user?.username || '未登录' }}
            </span>
            <n-tag size="tiny" :bordered="false">{{ roleLabel }}</n-tag>
            <span class="toolbar-caret">▾</span>
          </div>
        </n-dropdown>
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
          <span>CPU 架构</span>
          <CopyValue :value="device?.cpuArch" />
        </div>
        <div class="info-row">
          <span>CPU 代号</span>
          <CopyValue :value="device?.cpuCode" />
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
        <n-spin v-if="loading && sessionId" :show="true" class="spin" />
        <div
          v-if="sessionId || isIos"
          class="player-shell"
          :class="{ covered: pipActive }"
        >
          <DevicePlayer
            ref="playerRef"
            :key="isIos ? `ios-${reloadNonce}` : `${sessionId ?? ''}-${quality}-${reloadNonce}`"
            :session-id="sessionId ?? ''"
            :platform="device?.platform"
            :device-id="device?.id"
            :quality="quality"
            :control-allowed="controller"
            @controller-change="controller = $event"
            @error="errorText = $event"
            @control-released="onControlReleased"
            @viewers-allow="onViewersAllow"
            @ready="playerReady = true"
            @closed="onPlayerClosed"
          />
        </div>
        <div v-else-if="connecting" class="connecting">
          <n-spin :size="20" />
          <span>正在连接设备…</span>
        </div>
        <div v-else class="placeholder">
          <div class="placeholder-icon">
            <n-icon :size="32"><CloudOfflineOutline /></n-icon>
          </div>
          <div class="placeholder-title">
            {{ errorText || '画面连接已断开' }}
          </div>
          <div v-if="!errorText" class="placeholder-desc">
            可能是网络波动，或设备被其他操作占用。<br />
            重新连接会重新建立投屏会话。
          </div>
          <div v-else-if="viewerClosed" class="placeholder-desc">
            控制者关闭了查看权限，暂时无法继续观看。
          </div>
          <div v-else-if="lockedBlocked" class="placeholder-desc">
            设备已被管理员锁定，暂时不能控制或查看。
          </div>
          <button
            v-if="!viewerClosed && !lockedBlocked"
            type="button"
            class="placeholder-btn"
            @click="createSession"
          >
            重新连接
          </button>
        </div>

        <div
          v-if="sessionId && !isIos && !playerReady"
          class="connecting-overlay"
        >
          <n-spin :size="20" />
          <span>正在连接设备…</span>
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
          v-if="
            sessionId &&
            !controller &&
            !readonlyBannerClosed &&
            !releasedBy &&
            device?.control
          "
          class="readonly-banner"
        >
          <span>
            {{ controlName }} {{ controlSinceText }} 开始控制，你当前只能查看。
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

        <div
          v-if="sessionId && !allowViewers && !controller && !isAdmin"
          class="viewers-closed-overlay"
        >
          <div class="offline-title">控制者已关闭其他人查看</div>
          <div class="offline-desc">
            等待控制者重新开启后，画面会自动恢复。
          </div>
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

        <div v-if="isFullscreen && !controller" class="readonly-float">只读</div>

        <div v-if="recording" class="rec-badge">
          <span class="rec-dot" />
          <span>录制中</span>
        </div>

        <div class="stage-actions">
          <button type="button" class="overlay-btn" @click="togglePip">
            <n-icon :size="13"><BrowsersOutline /></n-icon>
            {{ pipActive ? '收回画中画' : '画中画' }}
          </button>
          <button type="button" class="overlay-btn" @click="toggleWebFullscreen">
            <n-icon :size="13"><ScanOutline /></n-icon>
            {{ isWebFullscreen ? '退出网页全屏' : '网页全屏' }}
          </button>
          <button type="button" class="overlay-btn" @click="toggleFullscreen">
            <n-icon :size="13"><ExpandOutline /></n-icon>
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
              <button type="button" class="bar-btn" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="sendKey('back')">
                <n-icon :size="13"><ArrowBackOutline /></n-icon>
                返回
              </button>
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('home')">
                <n-icon :size="13"><HomeOutline /></n-icon>
                主页
              </button>
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('recent')">
                <n-icon :size="13"><AlbumsOutline /></n-icon>
                任务
              </button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">音量</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('volumeDown')">
                <n-icon :size="13"><VolumeLowOutline /></n-icon>
                音量−
              </button>
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('volumeUp')">
                <n-icon :size="13"><VolumeHighOutline /></n-icon>
                音量+
              </button>
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('mute')">
                <n-icon :size="13"><VolumeMuteOutline /></n-icon>
                静音
              </button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">屏幕</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('power')">
                <n-icon :size="13"><PowerOutline /></n-icon>
                电源
              </button>
              <button type="button" class="bar-btn" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="setScreen(false)">
                <n-icon :size="13"><MoonOutline /></n-icon>
                息屏
              </button>
              <button type="button" class="bar-btn" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="setScreen(true)">
                <n-icon :size="13"><SunnyOutline /></n-icon>
                亮屏
              </button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">抓取</div>
            <div class="fs-grid cols-2">
              <button type="button" class="bar-btn" :disabled="!controller" @click="copyScreenshot">
                <n-icon :size="13"><CopyOutline /></n-icon>
                复制截图
              </button>
              <button type="button" class="bar-btn" :disabled="!controller" @click="takeScreenshot">
                <n-icon :size="13"><CameraOutline /></n-icon>
                截图保存
              </button>
              <button
                type="button"
                class="bar-btn span-2"
                :class="{ recording }"
                :disabled="!controller"
                @click="toggleRecording"
              >
                <n-icon :size="13">
                  <StopCircleOutline v-if="recording" />
                  <VideocamOutline v-else />
                </n-icon>
                {{ recording ? '停止录屏' : '录屏' }}
              </button>
              <button
                type="button"
                class="bar-btn span-2"
                :class="{ on: safeKeyboard }"
                :disabled="!controller || isIos"
                :title="isIos ? iosTip : undefined"
                @click="toggleSafeKeyboard"
              >
                <n-icon :size="13"><KeypadOutline /></n-icon>
                {{ safeKeyboard ? '隐藏键盘' : '安全键盘' }}
              </button>
            </div>
          </div>

          <div class="fs-grid">
            <button type="button" class="bar-btn wide" @click="toggleFullscreen">
              <n-icon :size="13"><ExpandOutline /></n-icon>
              退出全屏
            </button>
          </div>
        </div>
      </div>

      <aside class="side" :class="{ readonly: !controller }">
        <section class="section">
          <div class="section-title">导航</div>
          <div class="grid-3">
            <n-button size="small" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="sendKey('back')">
              <template #icon>
                <n-icon><ArrowBackOutline /></n-icon>
              </template>
              返回
            </n-button>
            <n-button size="small" :disabled="!controller" @click="sendKey('home')">
              <template #icon>
                <n-icon><HomeOutline /></n-icon>
              </template>
              主页
            </n-button>
            <n-button size="small" :disabled="!controller" @click="sendKey('recent')">
              <template #icon>
                <n-icon><AlbumsOutline /></n-icon>
              </template>
              任务
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">音量</div>
          <div class="grid-3">
            <n-button size="small" :disabled="!controller" @click="sendKey('volumeDown')">
              <template #icon>
                <n-icon><VolumeLowOutline /></n-icon>
              </template>
              音量−
            </n-button>
            <n-button size="small" :disabled="!controller" @click="sendKey('volumeUp')">
              <template #icon>
                <n-icon><VolumeHighOutline /></n-icon>
              </template>
              音量+
            </n-button>
            <n-button size="small" :disabled="!controller" @click="sendKey('mute')">
              <template #icon>
                <n-icon><VolumeMuteOutline /></n-icon>
              </template>
              静音
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">设备</div>
          <div class="grid-3">
            <n-button size="small" :disabled="!controller" @click="sendKey('power')">
              <template #icon>
                <n-icon><PowerOutline /></n-icon>
              </template>
              电源
            </n-button>
            <n-button size="small" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="setScreen(false)">
              <template #icon>
                <n-icon><MoonOutline /></n-icon>
              </template>
              息屏
            </n-button>
            <n-button size="small" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="setScreen(true)">
              <template #icon>
                <n-icon><SunnyOutline /></n-icon>
              </template>
              亮屏
            </n-button>
          </div>
          <div class="grid-2">
            <n-button size="small" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="fileShow = true">
              <template #icon>
                <n-icon><FolderOpenOutline /></n-icon>
              </template>
              文件管理
            </n-button>
            <n-button size="small" :disabled="!controller || isIos" :title="isIos ? iosTip : undefined" @click="openNotification">
              <template #icon>
                <n-icon><NotificationsOutline /></n-icon>
              </template>
              通知栏
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">抓取</div>
          <div class="grid-2">
            <n-button
              size="small"
              :disabled="!controller"
              title="截图到剪贴板"
              @click="copyScreenshot"
            >
              <template #icon>
                <n-icon><CopyOutline /></n-icon>
              </template>
              复制截图
            </n-button>
            <n-button
              size="small"
              :disabled="!controller"
              @click="takeScreenshot"
            >
              <template #icon>
                <n-icon><CameraOutline /></n-icon>
              </template>
              截图保存
            </n-button>
          </div>
          <n-button
            size="small"
            block
            class="record-btn"
            :class="{ recording }"
            :disabled="!controller"
            @click="toggleRecording"
          >
            <template #icon>
              <n-icon>
                <StopCircleOutline v-if="recording" />
                <VideocamOutline v-else />
              </n-icon>
            </template>
            {{ recording ? '停止录屏' : '录屏' }}
          </n-button>
        </section>

        <section class="section">
          <div class="section-title">应用</div>
          <div class="grid-2">
            <n-button size="small" @click="installShow = true">
              <template #icon>
                <n-icon><CloudDownloadOutline /></n-icon>
              </template>
              安装应用
            </n-button>
            <n-button size="small" @click="openApps">
              <template #icon>
                <n-icon><AppsOutline /></n-icon>
              </template>
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
            <template #icon>
              <n-icon><PaperPlaneOutline /></n-icon>
            </template>
            发送到设备
          </n-button>
          <n-button
            size="small"
            block
            :disabled="!controller || isIos"
            :title="isIos ? iosTip : undefined"
            @click="copyToDeviceClipboard"
          >
            <template #icon>
              <n-icon><CopyOutline /></n-icon>
            </template>
            复制到剪贴板
          </n-button>
          <n-button
            size="small"
            block
            :type="safeKeyboard ? 'primary' : 'default'"
            :ghost="safeKeyboard"
            :disabled="!controller || isIos"
            :title="isIos ? iosTip : undefined"
            @click="toggleSafeKeyboard"
          >
            <template #icon>
              <n-icon><KeypadOutline /></n-icon>
            </template>
            {{ safeKeyboard ? '隐藏安全键盘' : '安全键盘' }}
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

/* 网页全屏：页面内铺满，保留顶部工具栏与右侧原始操作列 */
.control-page.web-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.control-page.web-fullscreen .info-col {
  display: none;
}

/* 网页全屏不显示顶部工具栏，只保留右侧操作列 */
.control-page.web-fullscreen .toolbar {
  display: none;
}

.control-page.web-fullscreen .body {
  padding: 8px;
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

.toolbar-center {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  margin-right: auto;
}

.toolbar-right {
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
  cursor: pointer;
}

/* 整块都能触发下拉，点 tag / 名字都算 */
.toolbar-user > * {
  pointer-events: none;
}

.toolbar-user-icon {
  color: var(--text-dim);
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
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  cursor: pointer;
}

.viewers-switch:hover {
  border-color: var(--border-strong);
}

.viewers-switch span {
  color: var(--text-muted);
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
  /* 滚动条默认隐藏，鼠标移入才显示 */
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

.info-col:hover {
  scrollbar-color: #d4d4d8 transparent;
}

.info-col::-webkit-scrollbar {
  width: 6px;
}

.info-col::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background: transparent;
}

.info-col:hover::-webkit-scrollbar-thumb {
  background: #d4d4d8;
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
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

/* 录制中：红色背景 + 呼吸闪烁 */
@keyframes rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.bar-btn.recording {
  background: #dc2626;
  border-color: #dc2626;
  color: #ffffff;
  animation: rec-pulse 1.1s ease-in-out infinite;
}

.bar-btn.on {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}

.bar-btn.recording:hover {
  background: #b91c1c;
}

.record-btn.recording {
  background: #dc2626 !important;
  border-color: #dc2626 !important;
  color: #ffffff !important;
  animation: rec-pulse 1.1s ease-in-out infinite;
}

/* 全屏只读提示 */
.readonly-float {
  position: absolute;
  top: 10px;
  left: 50%;
  z-index: 12;
  transform: translateX(-50%);
  padding: 3px 12px;
  border-radius: 999px;
  background: #f59e0b;
  color: #ffffff;
  font-size: 12px;
}

/* 左上角录制指示 */
.rec-badge {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(9, 9, 11, 0.88);
  color: #fafafa;
  font-size: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(6px);
}

.rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
  animation: rec-blink 1.1s ease-in-out infinite;
}

@keyframes rec-blink {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
  }
  50% {
    opacity: 0.35;
    box-shadow: 0 0 0 4px rgba(239, 68, 68, 0);
  }
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

/* 连接中：不要一进来就显示「画面已断开」 */
.connecting {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  height: 100%;
  color: #a1a1aa;
  font-size: 12px;
}

.connecting-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(9, 9, 11, 0.92);
  color: #a1a1aa;
  font-size: 12px;
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

.viewers-closed-overlay {
  position: absolute;
  inset: 0;
  z-index: 11;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  background: rgba(9, 9, 11, 0.92);
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
  width: 260px;
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