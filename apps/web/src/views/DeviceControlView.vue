<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NCheckbox,
  NDropdown,
  NIcon,
  NInput,
  NModal,
  NPopover,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  type DropdownOption,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  AlbumsOutline,
  AppsOutline,
  ArrowBackOutline,
  BrowsersOutline,
  CameraOutline,
  ChevronDownOutline,
  CloudDownloadOutline,
  CloudOfflineOutline,
  DesktopOutline,
  CloseCircleOutline,
  CopyOutline,
  EllipsisVerticalOutline,
  EyeOutline,
  ExpandOutline,
  FolderOpenOutline,
  GridOutline,
  HomeOutline,
  InformationCircleOutline,
  KeypadOutline,
  LockClosedOutline,
  LockOpenOutline,
  MoonOutline,
  NotificationsOutline,
  PaperPlaneOutline,
  PhonePortraitOutline,
  PersonCircleOutline,
  PowerOutline,
  RefreshOutline,
  ScanOutline,
  ShareSocialOutline,
  StopCircleOutline,
  SunnyOutline,
  SwapHorizontalOutline,
  TrashOutline,
  VideocamOutline,
  VolumeHighOutline,
  VolumeLowOutline,
  VolumeMuteOutline,
} from '@vicons/ionicons5';
import DeviceFileBrowser from '../components/DeviceFileBrowser.vue';
import DevicePlayer from '../components/DevicePlayer.vue';
import DeviceAppsDrawer from '../components/DeviceAppsDrawer.vue';
import DeviceStats from '../components/DeviceStats.vue';
import DevicePerfPanel from '../components/DevicePerfPanel.vue';
import InstallAppModal from '../components/InstallAppModal.vue';
import SafeKeyboardOverlay from '../components/SafeKeyboardOverlay.vue';
import CopyValue from '../components/CopyValue.vue';
import AiAssistantPanel from '../components/AiAssistantPanel.vue';
import {
  BUILTIN_AGENT_ID,
  type SafeKeyboardLayout,
  type StreamViewerInfo,
} from '@adh/protocol';
import { api } from '../api';
import { stopFleet, useFleet } from '../stores/fleet';
import { useAuth } from '../stores/auth';
import { usePreviews } from '../stores/previews';
import { copyText } from '../utils/clipboard';
import { openDevicePip, supportsDocumentPip } from '../utils/document-pip';
import { fileTimestamp, safeFileName, saveBlob } from '../utils/download';
import {
  formatDateTime,
  formatMemory,
  formatResolution,
  formatDuration,
} from '../utils/format';
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
// AI 栏常驻状态存本地，刷新后保持上次的展开/收起
const aiOpen = ref(localStorage.getItem('adh.ai.open') === '1');
const infoOpen = ref(localStorage.getItem('adh.info.open') !== '0');
const sideOpen = ref(localStorage.getItem('adh.side.open') !== '0');
const perfOpen = ref(localStorage.getItem('adh.perf.open') === '1');

/** 画面上叠加元素的开关，全部可按需关掉。 */
function flag(key: string, fallback: boolean): Ref<boolean> {
  const saved = localStorage.getItem(key);
  return ref(saved === null ? fallback : saved === '1');
}

const showLatencyHud = flag('adh.hud.latency', true);
const showFps = flag('adh.hud.fps', true);
const showStageActions = flag('adh.stage.actions', true);
const showPipZoom = flag('adh.stage.zoom', true);

function setFlag(key: string, target: Ref<boolean>, value: boolean): void {
  target.value = value;
  localStorage.setItem(key, value ? '1' : '0');
}

// 模板里 ref 会自动解包，所以这里导出成普通函数，避免把 boolean 当成 Ref 传进去
const toggles = {
  latency: (value: boolean) => setFlag('adh.hud.latency', showLatencyHud, value),
  fps: (value: boolean) => setFlag('adh.hud.fps', showFps, value),
  actions: (value: boolean) => setFlag('adh.stage.actions', showStageActions, value),
  zoom: (value: boolean) => setFlag('adh.stage.zoom', showPipZoom, value),
};
const aiAvailable = ref(false);
const loading = ref(true);
const errorText = ref<string | null>(null);
/** 安卓设备 + 非安全上下文：浏览器没有 WebCodecs，直接停在说明页，不建会话。 */
const codecBlocked = ref(false);
const codecHints = computed(() => webCodecsHints());
const viewerClosed = computed(() =>
  Boolean(errorText.value?.includes('关闭其他人查看')),
);
const controller = ref(false);
/** 当前会话的观看者名单（仅 Android / 远程 iOS 有投屏会话）。 */
const viewers = ref<StreamViewerInfo[]>([]);
const text = ref('');
const fileShow = ref(false);
const appsShow = ref(false);
const installShow = ref(false);
const stageRef = ref<HTMLElement | null>(null);
const pageRef = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const isWebFullscreen = ref(false);
const recording = ref(false);

function toggleSider(): void {
  infoOpen.value = !infoOpen.value;
  localStorage.setItem('adh.info.open', infoOpen.value ? '1' : '0');
}

function toggleSidebar(): void {
  sideOpen.value = !sideOpen.value;
  localStorage.setItem('adh.side.open', sideOpen.value ? '1' : '0');
}

function togglePerf(): void {
  perfOpen.value = !perfOpen.value;
  localStorage.setItem('adh.perf.open', perfOpen.value ? '1' : '0');
}

async function toggleFullscreen(): Promise<void> {
  // 原生全屏放大整个控制页（工具栏 + 画面 + AI 栏），
  // 这样顶部的「收起 AI / 展开 AI」按钮在全屏里仍然可用。
  const element = pageRef.value;
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

/** 网页全屏：页面内铺满，保留顶部工具栏与右侧操作列。 */
function toggleWebFullscreen(): void {
  isWebFullscreen.value = !isWebFullscreen.value;
}

function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === pageRef.value;
}

const deviceId = computed(() => String(route.params.id ?? ''));
const device = computed(
  () => devices.value.find((item) => item.id === deviceId.value) ?? null,
);

/* ---------------------------- 分享 ---------------------------- */

const shareVisible = ref(false);

const shareLink = computed(() => {
  const id = device.value?.id;
  return id ? `${window.location.origin}/devices/${id}/control` : '';
});

const shareText = computed(() => {
  if (!shareLink.value) return '';
  return `我邀请你查看「${device.value?.name ?? '设备'}」\n${shareLink.value}`;
});

function openShare(): void {
  if (!device.value) return;
  shareVisible.value = true;
}

async function copyShareInvite(): Promise<void> {
  if (!shareText.value) {
    message.warning('邀请内容还没准备好，请稍后重试');
    return;
  }
  const ok = await copyText(shareText.value);
  if (ok) {
    message.success('邀请内容已复制，直接发给对方即可');
    return;
  }
  // 浏览器拦截自动复制时，帮用户选中内容，按 Ctrl+C 即可
  message.warning('浏览器拦截了自动复制，已选中内容，请按 Ctrl + C');
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '.share-body textarea',
  );
  textarea?.focus();
  textarea?.select();
}

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
/** 远程 agent 上的 iOS：要等投屏会话建立后才渲染播放器，否则会先走本机的截图轮询。 */
const isRemoteIos = computed(
  () => isIos.value && device.value?.agentId !== BUILTIN_AGENT_ID,
);
/** iOS 端不支持的操作统一提示。 */
const iosTip = 'iOS 暂不支持该操作';
/** 设备侧直连 App（无宿主机 Agent）。 */
const isPortal = computed(
  () => device.value?.capabilities?.includes('portal') ?? false,
);
/** 直连 App 没有 scrcpy 的「只关背光」，息屏等于锁屏，会直接中断投屏。 */
const portalScreenTip = '设备无线直连不支持息屏 / 亮屏：息屏会锁屏并中断投屏';
/** 直连 App 调音量在部分 ROM 上不生效，先禁用。 */
const portalVolumeTip = '设备无线直连暂不支持音量控制，请在手机上直接调节';
/** 文件管理 / 应用管理只支持 server 本机接入的设备。 */
const isLocalDevice = computed(
  () => device.value?.agentId === BUILTIN_AGENT_ID,
);
const localOnlyTip = isPortal
  ? '直连模式暂不支持该操作'
  : '该功能需要 server 本机接入的设备';

/** iOS 帧率说明：关掉后记住，不再打扰。 */
const IOS_FPS_TIP_KEY = 'adh.ios-fps-tip.dismissed';
const iosFpsTipVisible = ref(localStorage.getItem(IOS_FPS_TIP_KEY) !== '1');

function dismissIosFpsTip(): void {
  iosFpsTipVisible.value = false;
  localStorage.setItem(IOS_FPS_TIP_KEY, '1');
}
const quality = ref<'low' | 'medium' | 'high' | 'ultra'>('medium');
const pipActive = ref(false);
let docPip: Window | null = null;

/** 画中画窗口的等比缩放百分比（1~100），记在本地。 */
const PIP_ZOOM_KEY = 'adh.pip.zoom.v2';
const pipZoom = ref(
  Math.min(100, Math.max(1, Number(localStorage.getItem(PIP_ZOOM_KEY)) || 100)),
);

/**
 * 按百分比缩放主预览画面（iOS / Android / 直连 / 宿主机 Agent 通用）。
 * 只改 CSS transform，不动画布尺寸，也不影响触摸坐标换算。
 */
function applyPipZoom(percent: number): void {
  const value = Math.min(100, Math.max(1, Math.round(percent)));
  pipZoom.value = value;
  localStorage.setItem(PIP_ZOOM_KEY, String(value));
}

function onPipZoomInput(event: Event): void {
  applyPipZoom(Number((event.target as HTMLInputElement).value));
}

/** 重置：按实际画面像素算出铺满可用区域的比例。 */
function resetPipZoom(): void {
  const size = playerRef.value?.getFrameSize?.();
  const host = stageRef.value;
  if (!size?.width || !size?.height || !host) {
    applyPipZoom(100);
    return;
  }
  // .player 四周各 12px padding
  const availWidth = Math.max(80, host.clientWidth - 24);
  const availHeight = Math.max(80, host.clientHeight - 24);
  const ratio = Math.min(availWidth / size.width, availHeight / size.height);
  applyPipZoom(Math.min(100, Math.max(1, Math.round(ratio * 100))));
}
const reloadNonce = ref(0);
const safeKeyboard = ref(false);
/** 密码输入键盘 / 虚拟全键盘。 */
const keyboardType = ref<'password' | 'full'>('password');
const readonlyBannerClosed = ref(false);
const releasedBy = ref('');
/** iOS 自己主动断开后，显示「重新连接」而不是「接管」。 */
const selfLeft = ref(false);

function onControlReleased(username: string): void {
  // 自己主动断开：页面保持只读，不弹接管提示
  if (username && username === user.value?.username) {
    releasedBy.value = '';
    readonlyBannerClosed.value = false;
    message.success('已断开控制，当前仅可查看');
    return;
  }
  releasedBy.value = username || '控制者';
  readonlyBannerClosed.value = false;
}

const allowViewers = ref(true);

// iOS 没有 WebSocket 会话，通过 device.updated 同步查看权限
watch(
  () => device.value?.allowViewers,
  (value, previous) => {
    if (value === undefined) return;
    allowViewers.value = value;
    if (!isIos.value || controller.value || isAdmin.value) return;
    // 关闭查看时停止拉流，重新开启时重挂播放器恢复画面
    if (!value) playerRef.value?.stopStream();
    else if (previous === false) reloadNonce.value += 1;
  },
  { immediate: true },
);

const playerReady = ref(false);

watch([sessionId, quality, reloadNonce], () => {
  playerReady.value = false;
});

/** 连接状态胶囊：连接中 / 已连接（绿） / 失败（红）。 */
const connState = computed<{ tone: 'wait' | 'ok' | 'bad'; text: string }>(() => {
  if (errorText.value) return { tone: 'bad', text: '连接失败' };
  if (playerReady.value) return { tone: 'ok', text: '已连接' };
  return { tone: 'wait', text: '连接中' };
});

/** 设备被锁定后，任何人都不能控制或查看，只有管理员能解锁。 */
const lockedBlocked = computed(() => Boolean(device.value?.locked));

/** 首次进入 / 重连时显示「正在连接」，不要一上来就提示断开。 */
const connecting = computed(
  () =>
    loading.value ||
    // 远程 iOS 也在等投屏会话建立，本机 iOS 直接走 WDA，不需要等
    (!sessionId.value &&
      (!isIos.value || isRemoteIos.value) &&
      !errorText.value &&
      !lockedBlocked.value),
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
  {
    label: '删除设备',
    key: 'delete',
    icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
    props: { style: 'color: #dc2626' },
  },
]);

/** 控制页里删除当前设备记录，删完退回设备列表。 */
function confirmDeleteDevice(): void {
  const current = device.value;
  if (!current) return;
  dialog.warning({
    title: '删除设备',
    content: `确定删除「${current.marketName || current.name}」的设备记录吗？只影响平台数据，不会卸载手机上的应用。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteDevice(current.id);
        message.success('已删除设备');
        void router.replace('/devices');
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

async function onMoreSelect(key: string): Promise<void> {
  if (key === 'delete') {
    confirmDeleteDevice();
    return;
  }
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

/** 当前观看者（排除控制者和自己），由服务端 viewer.list 推送；只显示显示名。 */
const observerNames = computed(() =>
  viewers.value
    .filter((viewer) => !viewer.controller && viewer.userId !== user.value?.id)
    .map((viewer) => viewer.displayName || '未命名'),
);

const observerLabel = computed(() => {
  const names = observerNames.value;
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 人`;
});

/** 正在看的人（含自己和控制者），用于右上角在线名单。 */
const watchingList = computed(() =>
  viewers.value.map((item) => ({
    ...item,
    label: item.displayName || item.username,
    since: formatClock(item.joinedAt),
    watching: item.joinedAt > 0 ? formatDuration(item.joinedAt, now.value) : '—',
  })),
);

function formatClock(ts: number): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

function onViewerList(list: StreamViewerInfo[]): void {
  viewers.value = list;
}

/** 直连设备回报的媒体音量，用一条轻提示确认操作已生效。 */
function onVolume(payload: {
  level: number;
  max: number;
  muted: boolean;
}): void {
  if (payload.muted || payload.level === 0) {
    message.info('设备已静音');
    return;
  }
  message.info(`设备音量 ${payload.level}/${payload.max}`);
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
    ? device.value.control.displayName || '未命名'
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
const canKick = computed(() => {
  if (!isAdmin.value) return false;
  const control = device.value?.control;
  if (!control || control.userId === user.value?.id) return false;
  // 管理员不能断开超级管理员
  if (control.role === 'superadmin' && user.value?.role !== 'superadmin') {
    return false;
  }
  return true;
});
const canTakeover = computed(() => {
  if (controller.value) return false;
  // 控制者主动释放后，任何观看者都能接管；其余情况只有管理员能抢
  if (releasedBy.value) return true;
  if (!isAdmin.value) return false;
  const control = device.value?.control;
  if (control?.role === 'superadmin' && user.value?.role !== 'superadmin') {
    return false;
  }
  return isIos.value || Boolean(sessionId.value);
});

async function takeoverControl(): Promise<void> {
  const current = device.value;
  if (!current) return;

  // iOS 没有 WebSocket 会话：管理员先强制收回，再申请到自己名下
  if (isIos.value) {
    try {
      if (!releasedBy.value) {
        await api.takeoverDeviceStream(current.id);
      }
      const result = await api.claimIosControl(current.id);
      if (!result.granted) {
        message.warning(
          `${result.control?.username ?? '其他用户'} 正在控制，无法接管`,
        );
        return;
      }
      controller.value = true;
      releasedBy.value = '';
      readonlyBannerClosed.value = false;
      startIosHeartbeat();
      message.success('已接管控制权');
      await refresh();
    } catch (error) {
      message.warning(
        error instanceof Error ? error.message : '控制权已被其他人接管',
      );
      await refresh();
    }
    return;
  }

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
  }, 10_000);
}

/** 断开后关闭当前控制标签页；浏览器拒绝关闭时退回设备列表。 */
function closeControlTab(): void {
  window.close();
  // 非脚本打开的标签页无法 close，兜底回到设备列表
  window.setTimeout(() => {
    if (!window.closed) void router.replace('/devices');
  }, 200);
}

async function stopControl(): Promise<void> {
  const current = device.value;
  if (!current) return;

  // iOS 没有服务端投屏会话，断开就是释放控制权
  if (isIos.value) {
    stopIosHeartbeat();
    selfReleased = true;
    // 先切状态再发请求：服务端广播 control 变空时不会误判成「别人断开」
    selfLeft.value = true;
    releasedBy.value = '';
    readonlyBannerClosed.value = false;
    controller.value = false;
    try {
      await api.stopDeviceStream(current.id);
    } catch {
      /* 控制权可能已经超时释放 */
    }
    message.success('已断开控制');
    closeControlTab();
    return;
  }

  try {
    await api.stopDeviceStream(current.id);
    message.success('已断开控制');
  } catch (error) {
    /* 会话可能已经结束 */
    message.warning(error instanceof Error ? error.message : '断开失败');
  }
  closeControlTab();
}

/** iOS 自己断开后重新申请控制权。 */
async function resumeIosControl(): Promise<void> {
  if (!isIos.value || !device.value) return;
  try {
    const result = await api.claimIosControl(device.value.id);
    if (!result.granted) {
      selfLeft.value = false;
      releasedBy.value = result.control?.username ?? '其他用户';
      readonlyBannerClosed.value = false;
      message.warning(`${releasedBy.value} 正在控制，当前只能查看`);
      await refresh();
      return;
    }
    selfLeft.value = false;
    controller.value = true;
    startIosHeartbeat();
    message.success('已重新获得控制权');
    await refresh();
  } catch (error) {
    message.warning(
      error instanceof Error ? error.message : '无法获取控制权',
    );
  }
}

watch(controller, (value, previous) => {
  if (value) readonlyBannerClosed.value = false;
  if (!value) safeKeyboard.value = false;
  // 失去控制权后立即收起 AI 面板，避免继续下发动作
  if (!value) aiOpen.value = false;
  if (previous === true && value === false && !selfReleased) {
    message.warning('控制权已被接管，你现在仅可查看');
  }
  selfReleased = false;
});

// 打开 AI 栏时刷新状态，并记住展开状态；管理员刚配置完模型也能立即生效
watch(
  aiOpen,
  async (open) => {
    localStorage.setItem('adh.ai.open', open ? '1' : '0');
    if (!open) return;
    try {
      aiAvailable.value = (await api.aiStatus()).enabled;
    } catch {
      aiAvailable.value = false;
    }
  },
  { immediate: true },
);

// iOS 没有 WebSocket 会话，通过 device.updated 推送感知被接管 / 被断开
let lastControlName = '';
watch(
  () => device.value?.control?.userId,
  (userId, previous) => {
    if (!isIos.value) return;
    const name = device.value?.control
      ? device.value.control.displayName || '未命名'
      : '';
    // 记住最近一次看到的控制者，断开推送里没有名字时可以还原
    if (name) lastControlName = name;

    if (controller.value) {
      if (userId && userId === user.value?.id) return;
      stopIosHeartbeat();
      selfReleased = true;
      controller.value = false;
      selfLeft.value = false;
      releasedBy.value = name || lastControlName || '控制者';
      readonlyBannerClosed.value = false;
      message.warning(
        name || lastControlName
          ? `控制权已被 ${name || lastControlName} 接管，你现在仅可查看`
          : '控制权已被释放，你现在仅可查看',
      );
      return;
    }

    // 只读观看：控制者断开时提示可以接管，并带上具体名字
    if (previous && !userId) {
      // 自己刚断开：显示「重新连接」，不显示接管提示
      if (selfLeft.value) return;
      releasedBy.value = lastControlName || '控制者';
      readonlyBannerClosed.value = false;
    } else if (userId) {
      selfLeft.value = false;
      releasedBy.value = '';
    }
  },
  { immediate: true },
);

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

/** 断开前二次确认，避免误点把控制权放掉。 */
function confirmStopControl(): void {
  dialog.warning({
    title: '断开连接',
    content: '断开后会释放这台设备的控制权，其他人可以接管。确定断开？',
    positiveText: '确定断开',
    negativeText: '取消',
    onPositiveClick: () => {
      void stopControl();
    },
  });
}

/** 强制踢掉别人时同样需要确认。 */
function confirmKickControl(): void {
  dialog.warning({
    title: '强制断开',
    content: '将强制断开当前控制者，对方会立即失去操作权限。确定继续？',
    positiveText: '强制断开',
    negativeText: '取消',
    onPositiveClick: () => {
      void kickControl();
    },
  });
}

/** 键盘位置 / 大小 / 类型存服务端，多人共享，也按设备区分。 */
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

function toggleKeyboard(type: 'password' | 'full'): void {
  if (safeKeyboard.value && keyboardType.value === type) {
    safeKeyboard.value = false;
    return;
  }
  keyboardType.value = type;
  safeKeyboard.value = true;
  // 打开时拉一次最新布局，别人调过的也能同步
  void refresh();
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

  // 直连设备：只让 App 重启编码器，投屏会话和 WebSocket 都不动
  if (isPortal.value) {
    playerRef.value?.setQuality(value);
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

/** 建立投屏会话最多等 10 秒，超时直接提示，避免一直卡在「连接中」。 */
const STREAM_CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(task: Promise<T>, ms: number, text: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(text)), ms);
    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
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
    errorText.value = null;
    try {
      const result = await api.claimIosControl(device.value.id);
      controller.value = result.granted;
      if (result.granted) {
        startIosHeartbeat();
        // 拉一次设备状态，顶部才能显示「谁 · 起控制 · 已用时长」
        await refresh();
      } else {
        // 被其他人占用：刷新设备状态，让只读横幅显示当前控制者
        readonlyBannerClosed.value = false;
        await refresh();
      }

      // 远程 agent 上的 iOS 由 agent 拉 WDA 流推给 server，需要建投屏会话；
      // 本机 iOS 直接走 WDA 的 HTTP MJPEG，不建会话。
      if (device.value.agentId !== BUILTIN_AGENT_ID) {
        loading.value = true;
        const stream = await api.createStream(device.value.id, quality.value);
        sessionId.value = stream.sessionId;
      } else {
        sessionId.value = null;
      }
    } catch (error) {
      controller.value = false;
      errorText.value =
        error instanceof Error ? error.message : '无法获取控制权';
    } finally {
      loading.value = false;
    }
    return;
  }

  loading.value = true;
  errorText.value = null;
  sessionId.value = null;

  // 安卓投屏依赖 WebCodecs，http + 局域网 IP 下浏览器不提供该 API
  if (!isWebCodecsAvailable()) {
    loading.value = false;
    codecBlocked.value = true;
    errorText.value = webCodecsReason();
    return;
  }
  codecBlocked.value = false;

  try {
    const result = await withTimeout(
      api.createStream(device.value.id, quality.value),
      STREAM_CONNECT_TIMEOUT_MS,
      '连接超时（10 秒），请检查设备是否在线或稍后重试',
    );
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
  message.warning('当前为仅查看模式，无法操作设备');
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
  // 直连设备调音量不生效，直接拦掉，避免点了没反应
  if (
    isPortal.value &&
    (key === 'volumeUp' || key === 'volumeDown' || key === 'mute')
  ) {
    message.warning(portalVolumeTip);
    return;
  }
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
  if (isPortal.value) {
    message.warning(portalScreenTip);
    return;
  }
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

/* ---------------------- 快捷导入设备相册 ---------------------- */

const galleryInput = ref<HTMLInputElement | null>(null);
const galleryBusy = ref(false);

function galleryExt(blob: Blob): string {
  const type = blob.type.toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'png';
}

async function pushImageToGallery(blob: Blob, name: string): Promise<void> {
  const deviceId = device.value?.id;
  if (!deviceId) return;
  if (blob.size > 10 * 1024 * 1024) {
    message.warning('图片超过 10MB，请压缩后再试');
    return;
  }
  galleryBusy.value = true;
  try {
    const result = await api.importDeviceGalleryImage(deviceId, blob, name);
    message.success(`已导入设备相册：${result.name}`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '导入相册失败');
  } finally {
    galleryBusy.value = false;
  }
}

function pickGalleryImage(): void {
  galleryInput.value?.click();
}

async function onGalleryFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空 value，允许连续选择同一张图片
  input.value = '';
  if (!file) return;
  await pushImageToGallery(
    file,
    file.name || `upload-${Date.now()}.${galleryExt(file)}`,
  );
}

/** 读取系统剪贴板：图片直接导入相册，文字只提示。 */
async function importClipboardToGallery(): Promise<void> {
  if (!navigator.clipboard?.read) {
    message.warning('当前地址不支持读取剪贴板，请改用 localhost 或 HTTPS 访问');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      await pushImageToGallery(
        blob,
        `clipboard-${Date.now()}.${galleryExt(blob)}`,
      );
      return;
    }

    let text = '';
    for (const item of items) {
      if (!item.types.includes('text/plain')) continue;
      text = await (await item.getType('text/plain')).text();
      break;
    }
    if (!text) text = await navigator.clipboard.readText().catch(() => '');
    message.warning(
      text ? '当前剪贴板是文字，无法导入相册' : '剪贴板里没有图片',
    );
  } catch {
    message.warning('读取剪贴板失败，请允许剪贴板权限后重试');
  }
}

/** 把当前设备画面截图直接存进设备相册。 */
async function importScreenshotToGallery(): Promise<void> {
  const blob = await playerRef.value?.screenshot();
  if (!blob) {
    message.warning('画面还没就绪，稍后再试');
    return;
  }
  await pushImageToGallery(blob, `screenshot-${Date.now()}.png`);
}

/* ---------------------- iOS：推送到 App 目录 ---------------------- */

const appFileInput = ref<HTMLInputElement | null>(null);
const appBundleId = ref('');
const appContainer = ref<'documents' | 'temp'>('documents');
const appOptions = ref<{ label: string; value: string }[]>([]);
const appsLoading = ref(false);

async function loadDeviceApps(): Promise<void> {
  if (appOptions.value.length > 0 || appsLoading.value) return;
  const deviceId = device.value?.id;
  if (!deviceId) return;
  appsLoading.value = true;
  try {
    const result = await api.listDeviceApps(deviceId);
    appOptions.value = result.packages.map((item) => ({
      label: item.label || item.name,
      value: item.name,
    }));
  } catch (error) {
    message.warning(
      error instanceof Error ? error.message : '读取应用列表失败',
    );
  } finally {
    appsLoading.value = false;
  }
}

function onAppSelectShow(show: boolean): void {
  if (show) void loadDeviceApps();
}

function pickAppImage(): void {
  if (!appBundleId.value) {
    message.warning('请先选择目标 App');
    return;
  }
  appFileInput.value?.click();
}

async function onAppFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await pushImageToApp(file, file.name || `image-${Date.now()}.png`);
}

async function pushImageToApp(blob: Blob, name: string): Promise<void> {
  const deviceId = device.value?.id;
  if (!deviceId) return;
  if (blob.size > 10 * 1024 * 1024) {
    message.warning('图片超过 10MB，请压缩后再试');
    return;
  }
  galleryBusy.value = true;
  try {
    const result = await api.importDeviceAppFile(deviceId, blob, {
      bundleId: appContainer.value === 'documents' ? appBundleId.value : '',
      container: appContainer.value,
      name,
    });
    message.success(`已推送到 App 目录：${result.path}`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '推送失败');
  } finally {
    galleryBusy.value = false;
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

/** 播放器错误：输入类提示用 toast，避免画面被错误占位替换。 */
function onPlayerError(text: string): void {
  if (text.includes('输入框') || text.includes('输入')) {
    message.warning(text);
    return;
  }
  errorText.value = text;
}

function onPlayerClosed(): void {  sessionId.value = null;
  playerReady.value = false;
  if (!errorText.value) {
    errorText.value = '画面连接已断开，点击重试';
  }
  releasedBy.value = '';
}

/** 设备断联后手动重连：先刷新设备状态，再重建播放器。 */
async function reconnect(): Promise<void> {
  await refresh();
  const current = device.value;
  if (!current) return;
  if (current.status !== 'online') {
    message.warning(
      isIos.value
        ? '设备仍未上线，请确认已信任电脑且 WDA 正在运行'
        : isPortal.value
          ? '设备仍未上线，请确认手机上的 ADH 直连 App 在运行并已连上服务器'
          : '设备仍未上线，请检查 USB 连接和 USB 调试开关',
    );
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

  // 控制页在独立标签页打开，ESC 只退出全屏，不再跳转
  if (isWebFullscreen.value) {
    isWebFullscreen.value = false;
  }
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
  // 记住上次的缩放比例，打开时直接套用
  applyPipZoom(pipZoom.value);
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

/** iOS 的控制权只由服务端申请结果决定，播放器不能反向覆盖。 */
function onPlayerControllerChange(value: boolean): void {
  if (isIos.value) return;
  controller.value = value;
}

/** 关闭 / 刷新页面不释放控制权；只有主动点「断开」才立即释放。 */

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
  // 刷新 / 关闭页面不释放 iOS 控制权，交给 TTL；只有主动点断开才立即释放
  stopIosHeartbeat();
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
      <div class="title">{{ device?.marketName || device?.name || '设备控制' }}</div>
      <n-icon
        class="conn-icon"
        :size="15"
        :title="isPortal ? '直连' : `Agent · ${agentName}`"
      >
        <PhonePortraitOutline v-if="isPortal" />
        <DesktopOutline v-else />
      </n-icon>
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
        v-if="observerNames.length"
        size="small"
        :bordered="false"
        round
        class="viewer-tag"
        :title="observerNames.join('、')"
      >
        观看：{{ observerLabel }}
      </n-tag>
      <n-tag
        v-if="(sessionId || isIos) && !controller"
        size="small"
        type="warning"
        :bordered="false"
      >
        仅查看
      </n-tag>

      <div class="toolbar-center">
        <span class="conn-pill" :class="connState.tone" :title="`投屏连接状态：${connState.text}`">
          <i class="conn-dot" />
          {{ connState.text }}
        </span>
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

        <!-- 正在观看的人：谁在看、什么时候开始、看了多久 -->
        <n-popover
          v-if="watchingList.length > 0"
          trigger="hover"
          placement="bottom-end"
          :show-arrow="false"
        >
          <template #trigger>
            <button type="button" class="presence-badge">
              <n-icon :size="13"><EyeOutline /></n-icon>
              {{ watchingList.length }}
            </button>
          </template>
          <div class="presence-panel">
            <div class="presence-title">正在查看（{{ watchingList.length }}）</div>
            <div
              v-for="item in watchingList"
              :key="item.userId"
              class="presence-item"
            >
              <div class="presence-main">
                <span class="presence-name">{{ item.label }}</span>
                <span v-if="item.controller" class="presence-tag">控制中</span>
              </div>
              <div class="presence-meta">
                {{ item.since }} 开始 · 已看 {{ item.watching }}
              </div>
            </div>
          </div>
        </n-popover>

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
        <n-popover trigger="click" placement="bottom-end" :show-arrow="false">
          <template #trigger>
            <n-button size="tiny" ghost title="显示 / 收起面板">
              显示
              <n-icon style="margin-left: 4px"><ChevronDownOutline /></n-icon>
            </n-button>
          </template>
          <div class="panel-toggles">
            <n-checkbox :checked="infoOpen" @update:checked="toggleSider">
              设备信息
            </n-checkbox>
            <n-checkbox :checked="sideOpen" @update:checked="toggleSidebar">
              操作栏
            </n-checkbox>
            <n-checkbox :checked="perfOpen" @update:checked="togglePerf">
              性能数据
            </n-checkbox>
            <n-checkbox
              :checked="aiOpen"
              :disabled="!controller"
              @update:checked="aiOpen = $event"
            >
              AI 助手
            </n-checkbox>
            <n-checkbox
              :checked="showLatencyHud"
              @update:checked="toggles.latency"
            >
              延迟
            </n-checkbox>
            <n-checkbox :checked="showFps" @update:checked="toggles.fps">
              帧率
            </n-checkbox>
            <n-checkbox
              :checked="showStageActions"
              @update:checked="toggles.actions"
            >
              画面按钮
            </n-checkbox>
            <n-checkbox :checked="showPipZoom" @update:checked="toggles.zoom">
              比例缩放
            </n-checkbox>
          </div>
        </n-popover>

        <n-button size="tiny" ghost @click="openShare">
          <template #icon>
            <n-icon><ShareSocialOutline /></n-icon>
          </template>
          分享
        </n-button>
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
          v-if="controller"
          size="tiny"
          type="error"
          ghost
          :disabled="!controller"
          @click="confirmStopControl"
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
          @click="confirmKickControl"
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
          {{ releasedBy ? '接管控制' : '强制接管' }}
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
      <aside v-if="infoOpen" class="info-col">
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

      <aside v-if="perfOpen" class="perf-col">
        <div class="section-title perf-title">
          <span>设备性能数据</span>
        </div>
        <DevicePerfPanel
          :device-id="device?.id ?? ''"
          :platform="isIos ? 'ios' : 'android'"
        />
      </aside>

      <div ref="stageRef" class="stage">
        <div
          v-if="!controller && (sessionId || isIos)"
          class="readonly-side"
          title="仅查看模式，无法操作设备"
        >
          仅查看
        </div>
        <n-spin v-if="loading && sessionId" :show="true" class="spin" />
        <div
          v-if="sessionId || (isIos && !isRemoteIos)"
          class="player-shell"
          :class="{ covered: pipActive }"
        >
          <DevicePlayer
            ref="playerRef"
            :key="`${isIos ? 'ios' : 'android'}-${sessionId ?? 'local'}-${quality}-${reloadNonce}`"
            :session-id="sessionId ?? ''"
            :platform="device?.platform"
            :device-id="device?.id"
            :quality="quality"
            :control-allowed="controller"
            :show-latency="showLatencyHud"
            :show-fps="showFps"
            :display-scale="pipZoom"
            @controller-change="onPlayerControllerChange"
            @error="onPlayerError"
            @control-released="onControlReleased"
            @viewers-allow="onViewersAllow"
            @viewer-list="onViewerList"
            @volume="onVolume"
            @ready="playerReady = true"
            @closed="onPlayerClosed"
          />
        </div>
        <div v-else-if="connecting" class="connecting">
          <n-spin :size="20" />
          <span>正在连接设备…</span>
        </div>
        <div v-else-if="codecBlocked" class="placeholder codec-blocked">
          <div class="placeholder-icon">
            <n-icon :size="32"><CloudOfflineOutline /></n-icon>
          </div>
          <div class="placeholder-title">{{ WEB_CODECS_TITLE }}</div>
          <div class="placeholder-desc">{{ errorText }}</div>
          <ul class="codec-hints">
            <li v-for="hint in codecHints" :key="hint">{{ hint }}</li>
          </ul>
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
          v-if="sessionId && !isIos && !playerReady && device?.status === 'online'"
          class="connecting-overlay"
        >
          <n-spin :size="20" />
          <span>正在连接设备…</span>
        </div>

        <div
          v-if="selfLeft && !controller"
          class="readonly-banner released"
        >
          <span>已断开控制，当前仅可查看</span>
          <n-button size="tiny" type="primary" @click="resumeIosControl">
            重新连接
          </n-button>
          <button
            type="button"
            class="banner-close"
            title="关闭提示"
            @click="selfLeft = false"
          >
            ×
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
          v-if="
            (sessionId || isIos) &&
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
          v-if="isIos && iosFpsTipVisible"
          class="ios-fps-tip"
        >
          <n-icon :size="16" class="ios-fps-tip-icon">
            <InformationCircleOutline />
          </n-icon>
          <div class="ios-fps-tip-body">
            <strong>iOS 投屏帧率说明</strong>
            <span>
              iOS 画面由 WebDriverAgent 逐帧抓取，每帧都要单独编码、传输，
              因此帧率约 10fps；快速滑动或动画场景会感觉不够跟手。后续会优化取流方式。
            </span>
          </div>
          <button
            type="button"
            class="ios-fps-tip-close"
            title="不再显示"
            @click="dismissIosFpsTip"
          >
            ×
          </button>
        </div>

        <div
          v-if="
            (sessionId || isIos) &&
            !allowViewers &&
            !controller &&
            !isAdmin &&
            device?.status === 'online'
          "
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
            <template v-if="isIos">
              请确认手机已信任这台电脑，并且 WebDriverAgent（WDA）正在运行。
            </template>
            <template v-else-if="isPortal">
              请确认手机上的 ADH 直连 App 正在运行，且已连上服务器。
            </template>
            <template v-else>
              请检查 USB 连接是否正常，以及设备是否已开启 USB 调试。
            </template>
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

        <div v-if="isFullscreen && !controller" class="readonly-float">仅查看</div>

        <div v-if="recording" class="rec-badge">
          <span class="rec-dot" />
          <span>录制中</span>
        </div>

        <div v-if="showStageActions || showPipZoom" class="stage-actions">
          <template v-if="showStageActions">
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
          </template>

          <div v-if="showPipZoom" class="pip-zoom-row" title="画中画等比缩放">
            <span class="pip-zoom-label">比例缩放</span>
            <input
              class="pip-zoom-range"
              type="range"
              min="1"
              max="100"
              step="1"
              :value="pipZoom"
              @input="onPipZoomInput"
            />
            <span class="pip-zoom-value">{{ pipZoom }}%</span>
            <button
              type="button"
              class="pip-zoom-reset"
              title="重置为自适应页面高度"
              @click.stop="resetPipZoom"
            >
              重置
            </button>
          </div>
        </div>

        <SafeKeyboardOverlay
          :visible="safeKeyboard"
          :device-id="device?.id"
          :layout="device?.safeKeyboard"
          :mode="keyboardType"
          @change="saveSafeKeyboard"
        />

        <div v-if="isFullscreen" class="fullscreen-bar">
          <div class="fs-group">
            <div class="fs-title">导航</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" :disabled="!controller" @click="sendKey('back')">
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
              <button type="button" class="bar-btn" :disabled="!controller || isPortal" :title="isPortal ? portalVolumeTip : undefined" @click="sendKey('volumeDown')">
                <n-icon :size="13"><VolumeLowOutline /></n-icon>
                音量−
              </button>
              <button type="button" class="bar-btn" :disabled="!controller || isPortal" :title="isPortal ? portalVolumeTip : undefined" @click="sendKey('volumeUp')">
                <n-icon :size="13"><VolumeHighOutline /></n-icon>
                音量+
              </button>
              <button type="button" class="bar-btn" :disabled="!controller || isPortal" :title="isPortal ? portalVolumeTip : undefined" @click="sendKey('mute')">
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
              <button type="button" class="bar-btn" :disabled="!controller || isIos || isPortal" :title="isIos ? iosTip : isPortal ? portalScreenTip : undefined" @click="setScreen(false)">
                <n-icon :size="13"><MoonOutline /></n-icon>
                息屏
              </button>
              <button type="button" class="bar-btn" :disabled="!controller || isIos || isPortal" :title="isIos ? iosTip : isPortal ? portalScreenTip : undefined" @click="setScreen(true)">
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
                :class="{ on: safeKeyboard && keyboardType === 'password' }"
                :disabled="!controller"
                @click="toggleKeyboard('password')"
              >
                <n-icon :size="13"><KeypadOutline /></n-icon>
                {{
                  safeKeyboard && keyboardType === 'password'
                    ? '收起密码键盘'
                    : '密码输入键盘'
                }}
              </button>
              <button
                type="button"
                class="bar-btn span-2"
                :class="{ on: safeKeyboard && keyboardType === 'full' }"
                :disabled="!controller"
                @click="toggleKeyboard('full')"
              >
                <n-icon :size="13"><GridOutline /></n-icon>
                {{
                  safeKeyboard && keyboardType === 'full'
                    ? '收起全键盘'
                    : '虚拟全键盘'
                }}
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

      <aside v-if="sideOpen" class="side" :class="{ readonly: !controller }">
        <section class="section">
          <div class="section-title">导航</div>
          <div class="grid-3">
            <n-button size="small" :disabled="!controller" @click="sendKey('back')">
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
          <div class="section-title">设备</div>
          <div class="grid-3">
            <n-button size="small" :disabled="!controller" @click="sendKey('power')">
              <template #icon>
                <n-icon><PowerOutline /></n-icon>
              </template>
              电源
            </n-button>
            <n-button size="small" :disabled="!controller || isIos || isPortal" :title="isIos ? iosTip : isPortal ? portalScreenTip : undefined" @click="setScreen(false)">
              <template #icon>
                <n-icon><MoonOutline /></n-icon>
              </template>
              息屏
            </n-button>
            <n-button size="small" :disabled="!controller || isIos || isPortal" :title="isIos ? iosTip : isPortal ? portalScreenTip : undefined" @click="setScreen(true)">
              <template #icon>
                <n-icon><SunnyOutline /></n-icon>
              </template>
              亮屏
            </n-button>
            <n-button size="small" :disabled="!controller || isPortal" :title="isPortal ? portalVolumeTip : undefined" @click="sendKey('volumeDown')">
              <template #icon>
                <n-icon><VolumeLowOutline /></n-icon>
              </template>
              音量−
            </n-button>
            <n-button size="small" :disabled="!controller || isPortal" :title="isPortal ? portalVolumeTip : undefined" @click="sendKey('volumeUp')">
              <template #icon>
                <n-icon><VolumeHighOutline /></n-icon>
              </template>
              音量+
            </n-button>
            <n-button size="small" :disabled="!controller || isPortal" :title="isPortal ? portalVolumeTip : undefined" @click="sendKey('mute')">
              <template #icon>
                <n-icon><VolumeMuteOutline /></n-icon>
              </template>
              静音
            </n-button>
          </div>
          <div class="grid-2">
            <n-button size="small" :disabled="!controller || isIos || !isLocalDevice" :title="isIos ? iosTip : !isLocalDevice ? localOnlyTip : undefined" @click="fileShow = true">
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
            <n-button size="small" :disabled="!isLocalDevice" :title="isLocalDevice ? undefined : localOnlyTip" @click="openApps">
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
            :type="
              safeKeyboard && keyboardType === 'password' ? 'primary' : 'default'
            "
            :ghost="safeKeyboard && keyboardType === 'password'"
            :disabled="!controller"
            @click="toggleKeyboard('password')"
          >
            <template #icon>
              <n-icon><KeypadOutline /></n-icon>
            </template>
            {{
              safeKeyboard && keyboardType === 'password'
                ? '收起密码键盘'
                : '密码输入键盘'
            }}
          </n-button>
          <n-button
            size="small"
            block
            :type="safeKeyboard && keyboardType === 'full' ? 'primary' : 'default'"
            :ghost="safeKeyboard && keyboardType === 'full'"
            :disabled="!controller"
            @click="toggleKeyboard('full')"
          >
            <template #icon>
              <n-icon><GridOutline /></n-icon>
            </template>
            {{
              safeKeyboard && keyboardType === 'full'
                ? '收起全键盘'
                : '虚拟全键盘'
            }}
          </n-button>
        </section>

        <section v-if="device?.platform === 'android'" class="section">
          <div class="section-title">相册导入</div>
          <div class="album-actions">
            <n-button
              size="small"
              :disabled="!controller || galleryBusy"
              @click="pickGalleryImage"
            >
              上传图片到相册
            </n-button>
            <n-button
              size="small"
              :disabled="!controller || galleryBusy"
              @click="importClipboardToGallery"
            >
              从剪贴板导入
            </n-button>
            <n-button
              size="small"
              :disabled="!controller || galleryBusy"
              @click="importScreenshotToGallery"
            >
              当前画面存相册
            </n-button>
          </div>
          <p class="album-hint">仅 Android；导入后自动刷新系统相册</p>
          <input
            ref="galleryInput"
            type="file"
            accept="image/*"
            class="album-input"
            @change="onGalleryFile"
          />
        </section>

        <section v-if="device?.platform === 'ios'" class="section">
          <div class="section-title">App 目录导入</div>
          <n-select
            v-model:value="appBundleId"
            size="small"
            filterable
            :options="appOptions"
            :loading="appsLoading"
            placeholder="选择目标 App"
            @update:show="onAppSelectShow"
          />
          <n-select
            v-model:value="appContainer"
            size="small"
            class="app-container-select"
            :options="[
              { label: 'Documents', value: 'documents' },
              { label: 'tmp', value: 'temp' },
            ]"
          />
          <n-button
            size="small"
            :disabled="!controller || galleryBusy"
            @click="pickAppImage"
          >
            上传图片到 App 目录
          </n-button>
          <p class="album-hint">写入 App 容器，测试 App 需自行读取该目录</p>
          <input
            ref="appFileInput"
            type="file"
            accept="image/*"
            class="album-input"
            @change="onAppFile"
          />
        </section>
      </aside>

      <aside v-if="aiOpen" class="ai-col">
        <AiAssistantPanel
          :device-id="device?.id ?? ''"
          :disabled="!controller"
          :available="aiAvailable"
          @close="aiOpen = false"
        />
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

    <n-modal
      v-model:show="shareVisible"
      preset="card"
      title="邀请查看设备"
      style="width: 460px; max-width: calc(100vw - 32px)"
    >
      <div class="share-body">
        <n-input
          :value="shareText"
          type="textarea"
          :rows="4"
          readonly
        />
        <div class="share-actions">
          <n-button type="primary" @click="copyShareInvite">
            <template #icon>
              <n-icon><CopyOutline /></n-icon>
            </template>
            复制邀请
          </n-button>
        </div>
      </div>
    </n-modal>
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

.control-page.web-fullscreen .perf-col {
  display: none;
}

/* 网页全屏：保留顶部工具栏，AI 开关仍可用 */
.control-page.web-fullscreen .body {
  padding: 8px;
}

/* 网页全屏保留 AI 栏，按窗口宽度自适应，避免窄屏挤压画面 */
.control-page.web-fullscreen .ai-col {
  width: min(380px, 32vw);
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

/* 投屏连接状态：绿色是明确的「已连接」信号 */
.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
}

.conn-pill.wait {
  background: #f4f4f5;
  color: #71717a;
}

.conn-pill.ok {
  background: #dcfce7;
  color: #15803d;
}

.conn-pill.bad {
  background: #fee2e2;
  color: #b91c1c;
}

.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.conn-pill.ok .conn-dot {
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.18);
}

.conn-pill.wait .conn-dot {
  animation: conn-blink 1.2s ease-in-out infinite;
}

@keyframes conn-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

/* 右上角在线人数徽标 */
.presence-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
  cursor: default;
}

.presence-badge:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.presence-panel {
  min-width: 210px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 0;
}

.presence-title {
  font-size: 11px;
  color: var(--text-faint);
}

.presence-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.presence-main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.presence-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}

.presence-tag {
  padding: 0 5px;
  border-radius: 999px;
  background: #dcfce7;
  color: #15803d;
  font-size: 10px;
  line-height: 15px;
}

.presence-meta {
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.panel-toggles {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 118px;
  padding: 2px 4px;
}

.share-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.share-tip {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

.share-actions {
  display: flex;
  justify-content: flex-end;
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

.conn-icon {
  flex: none;
  color: var(--text-dim);
}

.viewer-tag {
  max-width: 220px;
}

.viewer-tag :deep(.n-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  scrollbar-width: none;
}

/* 设备信息列内容较多，隐藏滚动条，仍可用滚轮滚动 */
.info-col::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* 常驻 AI 对话栏：作为 body 的第三列，不再用抽屉浮层 */
.ai-col {
  width: 380px;
  flex: none;
  min-height: 0;
  display: flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.ai-col > * {
  flex: 1;
  min-width: 0;
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
  /* 用 grid：三个按钮各占一列，下面的拖动条横跨三列，宽度自然和按钮组一致 */
  display: grid;
  grid-template-columns: auto auto auto;
  justify-content: end;
  gap: 6px;
  max-width: calc(100% - 20px);
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

/* 画中画缩放：占满三个按钮的列宽 */
.pip-zoom-row {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(10, 10, 11, 0.6);
  backdrop-filter: blur(6px);
  cursor: pointer;
}

.pip-zoom-label,
.pip-zoom-value {
  flex: none;
  font-size: 11px;
  color: #d4d4d8;
  line-height: 1;
}

.pip-zoom-value {
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pip-zoom-reset {
  flex: none;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.08);
  color: #e4e4e7;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
}

.pip-zoom-reset:hover {
  background: rgba(255, 255, 255, 0.2);
}

.pip-zoom-range {
  flex: 1;
  min-width: 0;
  height: 16px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.pip-zoom-range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.35);
}

.pip-zoom-range::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4.5px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
}

.pip-zoom-range::-moz-range-track {
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.35);
}

.pip-zoom-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 50%;
  background: #ffffff;
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

/* 只读模式：左下角提示，给左上角的延迟 / FPS 让位 */
.readonly-side {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 12;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.92);
  color: #ffffff;
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  user-select: none;
}

/* 录制指示：同样放左下角，避免和左上角 HUD 重叠 */
.rec-badge {
  position: absolute;
  bottom: 10px;
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

/* 原生全屏：保留工具栏，隐藏信息栏；全屏元素是整页 */
.control-page:fullscreen .body {
  padding: 8px;
}

.control-page:fullscreen .info-col {
  display: none;
}

.control-page:fullscreen .perf-col {
  display: none;
}

.control-page:fullscreen .ai-col {
  width: min(380px, 32vw);
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

/* WebCodecs 不可用时的分条建议 */
.codec-blocked .placeholder-desc {
  max-width: 460px;
  color: #a1a1aa;
}

.codec-hints {
  max-width: 460px;
  margin: 4px 0 0;
  padding-left: 18px;
  text-align: left;
  font-size: 12px;
  line-height: 1.8;
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

.ios-fps-tip {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  z-index: 11;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: min(580px, calc(100% - 32px));
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(15, 18, 24, 0.86);
  backdrop-filter: blur(8px);
  color: #d4d4d8;
  font-size: 12px;
  line-height: 1.65;
}

.ios-fps-tip-icon {
  flex: none;
  margin-top: 1px;
  color: #38bdf8;
}

.ios-fps-tip-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ios-fps-tip-body strong {
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

.ios-fps-tip-close {
  flex: none;
  width: 20px;
  height: 20px;
  margin-left: 2px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.ios-fps-tip-close:hover {
  background: rgba(255, 255, 255, 0.22);
}

.offline-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  /* 不透明底：下面如果还有别的遮罩层，文字不会透出来叠在一起 */
  background: #09090b;
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

/* 设备性能数据列：PerfDog 风格的实时 CPU / 内存 / 帧率图表 */
.perf-col {
  width: 252px;
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow-y: auto;
  /* 图表列内容紧凑，不显示滚动条，避免和设备信息列一样出现竖条 */
  scrollbar-width: none;
}

.perf-col::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.perf-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
  /* 操作列滚动条默认隐藏，鼠标悬浮在操作列上才显示 */
  scrollbar-color: transparent transparent;
}

.side:hover {
  scrollbar-color: rgba(0, 0, 0, 0.18) transparent;
}

.side::-webkit-scrollbar-thumb {
  background: transparent;
}

.side:hover::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.18);
}

.side::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.26);
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

.album-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.album-hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}

.album-input {
  display: none;
}

.app-container-select {
  margin: 6px 0;
  width: 100%;
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

  .perf-col {
    width: 100%;
    max-height: 42vh;
  }

  .perf-col :deep(.metrics) {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .perf-col :deep(.metric) {
    flex: 1 1 150px;
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









