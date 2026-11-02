<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NSkeleton,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui';
import {
  CheckmarkOutline,
  CopyOutline,
  DownloadOutline,
} from '@vicons/ionicons5';
import type { AgentDetail } from '@adh/protocol';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
import { copyText } from '../utils/clipboard';
import { buildConnectCommand } from '../utils/command';
import { formatAgo, formatDateTime } from '../utils/format';

const props = defineProps<{ show: boolean; agentId: string | null }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const { devices } = useFleet();

const detail = ref<AgentDetail | null>(null);
const loading = ref(false);
const serverPort = ref(8080);
const copied = ref<string | null>(null);
const now = ref(Date.now());

let ticker: ReturnType<typeof setInterval> | null = null;

function stopTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

watch(
  () => [props.show, props.agentId] as const,
  async ([visible, id]) => {
    stopTicker();
    if (!visible || !id) return;
    loading.value = true;
    detail.value = null;
    copied.value = null;
    now.value = Date.now();
    ticker = setInterval(() => (now.value = Date.now()), 10_000);
    try {
      const [info, data] = await Promise.all([
        api.serverInfo().catch(() => ({ port: 8080, version: '' })),
        api.getAgent(id),
      ]);
      serverPort.value = info.port;
      detail.value = data;
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载详情失败');
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

onUnmounted(stopTicker);

const agent = computed(() => detail.value?.agent ?? null);

const deviceList = computed(() => {
  const current = agent.value;
  if (!current) return [];
  return devices.value.filter((device) => device.agentId === current.id);
});

const command = computed(() =>
  detail.value && !detail.value.agent.builtin
    ? buildConnectCommand(detail.value.key, serverPort.value)
    : '',
);









const statusMeta = computed(() => {
  const current = agent.value;
  if (!current) return { type: 'default' as const, label: '—' };
  if (current.online) return { type: 'success' as const, label: '在线' };
  if (current.pending) return { type: 'warning' as const, label: '待接入' };
  return { type: 'default' as const, label: '离线' };
});

const runtimeEnv = computed(() => {
  const current = agent.value;
  if (!current || !current.os) return '尚未接入';
  return `${current.os} / ${current.arch}`;
});

function downloadAgent(): void {
  window.location.href = api.agentPackageUrl();
}

function deviceStatusLabel(status: string): string {
  if (status === 'online') return '在线';
  if (status === 'unauthorized') return '未授权';
  return '离线';
}

function deviceStatusType(status: string): 'success' | 'warning' | 'default' {
  if (status === 'online') return 'success';
  if (status === 'unauthorized') return 'warning';
  return 'default';
}

async function copy(value: string, which: string): Promise<void> {
  const ok = await copyText(value);
  if (ok) {
    copied.value = which;
    message.success('已复制');
    window.setTimeout(() => {
      if (copied.value === which) copied.value = null;
    }, 2000);
  } else {
    message.error('复制失败，请手动选中文本复制');
  }
}
</script>

<template>
  <n-drawer
    :show="show"
    :width="580"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content title="节点详情" closable>
      <n-skeleton v-if="loading" text :repeat="10" />

      <template v-else-if="agent">
        <n-descriptions
          :column="1"
          label-placement="left"
          bordered
          size="small"
          :label-style="{ width: '96px' }"
        >
          <n-descriptions-item label="显示名称">
            <n-space align="center" :size="6">
              <span>{{ agent.name }}</span>
              <n-tag v-if="agent.builtin" size="tiny" type="info" :bordered="false" round>
                内置
              </n-tag>
            </n-space>
          </n-descriptions-item>
          <n-descriptions-item label="宿主机名">
            {{ agent.hostName ?? '—' }}
          </n-descriptions-item>
          <n-descriptions-item label="状态">
            <n-tag size="small" :type="statusMeta.type" :bordered="false" round>
              {{ statusMeta.label }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="运行环境">{{ runtimeEnv }}</n-descriptions-item>
          <n-descriptions-item label="版本号">
            {{ agent.version ? `v${agent.version}` : '—' }}
          </n-descriptions-item>
          <n-descriptions-item label="设备数">{{ agent.deviceCount }}</n-descriptions-item>
          <n-descriptions-item label="Key">
            <code class="key-text">{{ agent.builtin ? '由 server 自动管理' : agent.keyPreview }}</code>
          </n-descriptions-item>
          <n-descriptions-item label="创建时间">
            {{ formatDateTime(agent.createdAt) }}
          </n-descriptions-item>
          <n-descriptions-item label="最后心跳">
            <span :title="formatDateTime(agent.lastSeen)">
              {{ formatAgo(agent.lastSeen, now) }}
            </span>
          </n-descriptions-item>
        </n-descriptions>

        <section v-if="!agent.builtin" class="section">
          <h4>接入命令</h4>
          <div class="code-row">
            <pre class="code">{{ command }}</pre>
            <n-button size="small" @click="copy(command, 'command')">
              <template #icon>
                <n-icon :component="copied === 'command' ? CheckmarkOutline : CopyOutline" />
              </template>
              {{ copied === 'command' ? '已复制' : '复制' }}
            </n-button>
          </div>

          <h4 class="spaced">安装 Agent</h4>
          <div class="install-row">
            <n-button size="small" @click="downloadAgent">
              <template #icon>
                <n-icon :component="DownloadOutline" />
              </template>
              下载安装包
            </n-button>
            <span class="install-hint">
              目标机需要 Node.js ≥ 22 与 adb；iOS 还需要 go-ios
            </span>
          </div>

          <div class="steps">
            <p>1. 下载并解压安装包到任意目录</p>
            <p>
              2. 安装 Node.js ≥ 22；adb / go-ios 已装可忽略，否则运行
              <code>adh-agent init</code> 从安装包内置资源解压（无需联网）
            </p>
            <p>3. 执行上面的接入命令，设备会在几秒内出现在「设备管理」</p>
          </div>
        </section>

        <n-alert v-else type="info" :bordered="false" class="section">
          内置节点由 server 进程直接管理本机设备，无需接入命令。
        </n-alert>

        <section class="section">
          <h4>关联设备（{{ deviceList.length }}）</h4>
          <n-empty
            v-if="deviceList.length === 0"
            size="small"
            description="该节点暂无设备"
          />
          <div v-else class="device-list">
            <div v-for="device in deviceList" :key="device.id" class="device-row">
              <div class="device-line">
                <span class="device-name">{{ device.name }}</span>
                <n-tag
                  size="tiny"
                  :type="deviceStatusType(device.status)"
                  :bordered="false"
                  round
                >
                  {{ deviceStatusLabel(device.status) }}
                </n-tag>
              </div>
              <div class="device-meta">
                {{ device.osVersion ? `Android ${device.osVersion}` : '未知系统' }}
                <template v-if="device.cpu"> · {{ device.cpu }}</template>
                <template v-if="device.memoryMb"> · {{ Math.ceil(device.memoryMb / 1024) }} GB</template>
              </div>
            </div>
          </div>
        </section>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.key-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-dim);
}

.section {
  margin-top: 22px;
}

h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

h4.spaced {
  margin-top: 16px;
}

.code-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.code {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #15803d;
  white-space: pre-wrap;
  word-break: break-all;
}

.code.muted {
  color: var(--text-dim);
}

.install-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.install-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.steps {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.8;
}

.steps p {
  margin: 0;
}

.steps code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.device-row {
  padding: 9px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.device-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.device-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.device-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>