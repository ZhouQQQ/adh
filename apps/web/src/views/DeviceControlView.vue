<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NInput,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui';
import DevicePlayer from '../components/DevicePlayer.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
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

const deviceId = computed(() => String(route.params.id ?? ''));
const device = computed(
  () => devices.value.find((item) => item.id === deviceId.value) ?? null,
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

function rotate(): void {
  if (!requireController()) return;
  playerRef.value?.sendRotate();
}

function goBack(): void {
  void router.push('/devices');
}

onMounted(async () => {
  if (devices.value.length === 0) await refresh();
  await createSession();
});

onBeforeUnmount(() => {
  sessionId.value = null;
});
</script>

<template>
  <div class="control-page">
    <header class="toolbar">
      <n-button quaternary size="small" @click="goBack">← 返回设备列表</n-button>
      <div class="title">{{ device?.name ?? '设备控制' }}</div>
      <n-tag
        v-if="sessionId"
        size="small"
        :type="controller ? 'success' : 'warning'"
        :bordered="false"
      >
        {{ controller ? '可操作' : '只读' }}
      </n-tag>
      <div class="meta">
        <span>{{ resolutionText }}</span>
        <span v-if="device?.osVersion">Android {{ device.osVersion }}</span>
        <span>{{ agentName }}</span>
      </div>
    </header>

    <div class="body">
      <div class="stage">
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
            <n-button size="small" @click="rotate">旋转</n-button>
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

        <section class="section tips">
          <p>· 鼠标点击即触屏，按住拖动为滑动</p>
          <p>· 延迟约 80–150ms</p>
          <p>· 离开页面 30 秒后自动释放设备</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.control-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
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
}

.stage {
  flex: 1;
  min-width: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: #0b0b0d;
}

.spin {
  margin: auto;
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
  width: 208px;
  flex: none;
  border-left: 1px solid var(--border);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  background: var(--surface);
}

.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.tips {
  margin-top: auto;
  font-size: 11px;
  line-height: 1.8;
  color: var(--text-faint);
}

.tips p {
  margin: 0;
}

@media (max-width: 900px) {
  .body {
    flex-direction: column;
  }

  .side {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border);
    flex-direction: row;
    flex-wrap: wrap;
    gap: 12px;
    max-height: 40vh;
  }

  .section {
    min-width: 180px;
  }

  .tips {
    display: none;
  }
}
</style>