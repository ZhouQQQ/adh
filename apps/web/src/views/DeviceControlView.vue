<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NInput,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import DeviceFileBrowser from '../components/DeviceFileBrowser.vue';
import DevicePlayer from '../components/DevicePlayer.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
import { fileTimestamp, safeFileName, saveBlob } from '../utils/download';
import { formatResolution } from '../utils/format';

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
const installing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const recording = ref(false);
const fileShow = ref(false);

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
  key: 'home' | 'back' | 'recent' | 'power' | 'volumeUp' | 'volumeDown',
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

async function takeScreenshot(): Promise<void> {
  const blob = await playerRef.value?.screenshot();
  if (!blob) {
    message.warning('画面还没就绪，稍后再试');
    return;
  }
  saveBlob(blob, deviceFileName('png'));
  message.success('截图已保存');
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

function pickApk(): void {
  if (!device.value) return;
  fileInput.value?.click();
}

async function onApkSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !device.value) return;

  if (!file.name.toLowerCase().endsWith('.apk')) {
    message.error('请选择 .apk 文件');
    return;
  }

  installing.value = true;
  try {
    const uploaded = await api.uploadPackage(file);
    await api.installPackage(device.value.id, uploaded.id);
    message.success(`已安装 ${file.name}`);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '安装失败');
  } finally {
    installing.value = false;
  }
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
      <n-button quaternary size="small" @click="goBack">← 返回设备列表</n-button>
      <div class="title">{{ device?.name ?? '设备控制' }}</div>
      <n-tag
        v-if="sessionId && !controller"
        size="small"
        type="warning"
        :bordered="false"
      >
        只读
      </n-tag>
      <div class="meta">
        <span>{{ resolutionText }}</span>
        <span v-if="device?.osVersion">Android {{ device.osVersion }}</span>
        <span>{{ agentName }}</span>
      </div>
    </header>

    <div class="body">
      <div ref="stageRef" class="stage">
        <n-spin v-if="loading" :show="true" class="spin" />
        <DevicePlayer
          v-else-if="sessionId"
          ref="playerRef"
          :session-id="sessionId"
          @controller-change="controller = $event"
          @error="errorText = $event"
        />
        <div v-else class="placeholder">
          <span>{{ errorText ?? '正在建立投屏连接…' }}</span>
          <n-button v-if="errorText" size="small" @click="createSession">
            重试
          </n-button>
        </div>

        <button type="button" class="overlay-btn fs-toggle" @click="toggleFullscreen">
          {{ isFullscreen ? '退出全屏' : '全屏' }}
        </button>

        <div v-if="isFullscreen" class="fullscreen-bar">
          <button type="button" class="bar-btn" @click="sendKey('back')">返回</button>
          <button type="button" class="bar-btn" @click="sendKey('home')">主页</button>
          <button type="button" class="bar-btn" @click="sendKey('recent')">任务</button>
          <span class="bar-divider" />
          <button type="button" class="bar-btn" @click="sendKey('volumeDown')">音量−</button>
          <button type="button" class="bar-btn" @click="sendKey('volumeUp')">音量+</button>
          <button type="button" class="bar-btn" @click="sendKey('power')">电源</button>
          <span class="bar-divider" />
          <button type="button" class="bar-btn" @click="toggleFullscreen">退出全屏</button>
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
          <div class="grid-2">
            <n-button size="small" @click="sendKey('volumeDown')">音量 −</n-button>
            <n-button size="small" @click="sendKey('volumeUp')">音量 +</n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">设备</div>
          <div class="grid-2">
            <n-button size="small" @click="sendKey('power')">电源</n-button>
            <n-button size="small" @click="fileShow = true">文件管理</n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">抓取</div>
          <div class="grid-2">
            <n-button size="small" @click="takeScreenshot">截图</n-button>
            <n-button size="small" @click="toggleRecording">
              <span v-if="recording" class="rec-dot" />
              {{ recording ? '停止录制' : '录屏' }}
            </n-button>
          </div>
        </section>

        <section class="section">
          <div class="section-title">应用</div>
          <n-button
            size="small"
            block
            :loading="installing"
            :disabled="!device"
            @click="pickApk"
          >
            安装 APK
          </n-button>
          <input
            ref="fileInput"
            type="file"
            accept=".apk"
            hidden
            @change="onApkSelected"
          />
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
  </div>
</template>

<style scoped>
.control-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
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
  align-items: center;
  gap: 14px;
  padding: 14px;
}

.stage {
  flex: 1;
  min-width: 0;
  height: 680px;
  max-height: 100%;
  position: relative;
  background: #0b0b0d;
  border-radius: 10px;
  overflow: hidden;
}

.spin {
  margin: auto;
}

.overlay-btn {
  position: absolute;
  z-index: 10;
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

.fs-toggle {
  top: 10px;
  right: 10px;
}

.fullscreen-bar {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(10, 10, 11, 0.82);
  backdrop-filter: blur(12px);
  z-index: 10;
}

.bar-btn {
  width: 84px;
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

.stage:fullscreen .fs-toggle {
  display: none;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #a1a1aa;
}

.side {
  width: 200px;
  flex: none;
  height: 680px;
  max-height: 100%;
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

@media (max-width: 900px) {
  .body {
    flex-direction: column;
    padding: 10px;
    gap: 10px;
  }

  .side {
    width: 100%;
    height: auto;
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