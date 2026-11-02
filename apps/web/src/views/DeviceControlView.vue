<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NIcon,
  NInput,
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
import CopyValue from '../components/CopyValue.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
import { fileTimestamp, safeFileName, saveBlob } from '../utils/download';
import { formatDateTime, formatMemory, formatResolution } from '../utils/format';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { devices, agents, refresh } = useFleet();

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

const cpuText = computed(() => {
  const current = device.value;
  if (!current?.cpu) return '—';
  return current.cpuCores
    ? `${current.cpu} · ${current.cpuCores} 核`
    : current.cpu;
});

const brandText = computed(() => device.value?.brand ?? '—');

const sdkText = computed(() =>
  device.value?.sdk !== undefined ? `API ${device.value.sdk}` : '—',
);

const lastSeenText = computed(() =>
  device.value ? formatDateTime(device.value.lastSeen) : '—',
);

const publishedText = computed(() => {
  const value = device.value?.publishedAt ?? 0;
  if (value <= 0) return '未设置';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
});

async function createSession(): Promise<void> {
  if (!device.value) return;
  loading.value = true;
  errorText.value = null;
  sessionId.value = null;
  try {
    const result = await api.createStream(device.value.id);
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
  saveBlob(blob, deviceFileName('webm'));
  message.success('录屏已保存');
}

function onPlayerClosed(): void {
  sessionId.value = null;
  errorText.value = '画面连接已断开，点击重试';
}

function goBack(): void {
  void router.push('/devices');
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (devices.value.length === 0) await refresh();
  await createSession();
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.title = 'ADH · 设备农场';
  if (document.fullscreenElement === stageRef.value) {
    void document.exitFullscreen();
  }
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
        v-if="sessionId && !controller"
        size="small"
        type="warning"
        :bordered="false"
      >
        只读
      </n-tag>
    </header>

    <div class="body">
      <aside class="info-col">
        <div class="section-title">设备信息</div>
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
          <span>SDK</span>
          <CopyValue :value="sdkText" />
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

        <div class="section-title stats-title">运行状态</div>
        <DeviceStats :device-id="device?.id ?? ''" />
      </aside>

      <div ref="stageRef" class="stage">
        <n-spin v-if="loading" :show="true" class="spin" />
        <DevicePlayer
          v-else-if="sessionId"
          ref="playerRef"
          :session-id="sessionId"
          @controller-change="controller = $event"
          @error="errorText = $event"
          @closed="onPlayerClosed"
        />
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

        <div class="stage-actions">
          <button type="button" class="overlay-btn" @click="toggleFullscreen">
            {{ isFullscreen ? '退出全屏' : '全屏' }}
          </button>
        </div>

        <div v-if="isFullscreen" class="fullscreen-bar">
          <div class="fs-group">
            <div class="fs-title">导航</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" @click="sendKey('back')">返回</button>
              <button type="button" class="bar-btn" @click="sendKey('home')">主页</button>
              <button type="button" class="bar-btn" @click="sendKey('recent')">任务</button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">音量</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" @click="sendKey('volumeDown')">音量−</button>
              <button type="button" class="bar-btn" @click="sendKey('volumeUp')">音量+</button>
              <button type="button" class="bar-btn" @click="sendKey('mute')">静音</button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">屏幕</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" @click="sendKey('power')">电源</button>
              <button type="button" class="bar-btn" @click="setScreen(false)">息屏</button>
              <button type="button" class="bar-btn" @click="setScreen(true)">亮屏</button>
            </div>
          </div>

          <div class="fs-group">
            <div class="fs-title">抓取</div>
            <div class="fs-grid">
              <button type="button" class="bar-btn" @click="copyScreenshot">
                复制截图
              </button>
              <button type="button" class="bar-btn" @click="takeScreenshot">截图</button>
              <button type="button" class="bar-btn" @click="toggleRecording">
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

      <aside class="side">
        <section class="section">
          <div class="section-title">导航</div>
          <div class="grid-3">
            <n-button size="small" @click="sendKey('back')">返回</n-button>
            <n-button size="small" @click="sendKey('home')">主页</n-button>
            <n-button size="small" @click="sendKey('recent')">任务</n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">音量</div>
          <div class="grid-3">
            <n-button size="small" @click="sendKey('volumeDown')">音量−</n-button>
            <n-button size="small" @click="sendKey('volumeUp')">音量+</n-button>
            <n-button size="small" @click="sendKey('mute')">静音</n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">设备</div>
          <div class="grid-3">
            <n-button size="small" @click="sendKey('power')">电源</n-button>
            <n-button size="small" @click="setScreen(false)">息屏</n-button>
            <n-button size="small" @click="setScreen(true)">亮屏</n-button>
          </div>
          <div class="grid-2">
            <n-button size="small" @click="fileShow = true">文件管理</n-button>
            <n-button size="small" @click="openNotification">通知栏</n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">抓取</div>
          <div class="grid-3">
            <n-button size="small" title="截图到剪贴板" @click="copyScreenshot">
              复制截图
            </n-button>
            <n-button size="small" @click="takeScreenshot">截图</n-button>
            <n-button size="small" @click="toggleRecording">
              {{ recording ? '停止' : '录屏' }}
            </n-button>
          </div>
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

.title {
  font-size: 13px;
  font-weight: 600;
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
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
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