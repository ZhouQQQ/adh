<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NIcon, NModal, NSpace, useMessage } from 'naive-ui';
import {
  CheckmarkOutline,
  CopyOutline,
  DownloadOutline,
} from '@vicons/ionicons5';
import { api } from '../api';
import { copyText } from '../utils/clipboard';
import { buildConnectCommand } from '../utils/command';

const props = defineProps<{
  show: boolean;
  agentName: string;
  agentKey: string;
  isNew: boolean;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const serverPort = ref(8080);
const copied = ref<'command' | null>(null);

watch(
  () => props.show,
  async (visible) => {
    copied.value = null;
    if (!visible) return;
    try {
      const info = await api.serverInfo();
      serverPort.value = info.port;
    } catch {
      /* 保持默认端口 */
    }
  },
);

const command = computed(() =>
  buildConnectCommand(props.agentKey, serverPort.value),
);

function downloadAgent(): void {
  window.location.href = api.agentPackageUrl();
}

async function copy(value: string, which: 'command'): Promise<void> {
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

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="isNew ? `节点「${agentName}」已创建` : `节点「${agentName}」的 Key 已重置`"
    style="width: 680px"
    @update:show="emit('update:show', $event)"
  >
    <div class="key-panel">
      <n-alert type="warning" :bordered="false">
        Key 只显示这一次，关闭后无法再次查看。请立即复制并保存。
      </n-alert>

      <div class="field">
        <span class="label">在设备宿主机上执行</span>
        <div class="code-row">
          <pre class="code">{{ command }}</pre>
          <n-button size="small" @click="copy(command, 'command')">
            <template #icon>
              <n-icon
                :component="copied === 'command' ? CheckmarkOutline : CopyOutline"
              />
            </template>
            {{ copied === 'command' ? '已复制' : '复制' }}
          </n-button>
        </div>
      </div>

      <div class="field">
        <span class="label">还没安装 Agent？</span>
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
      </div>

      <div class="steps">
        <p>1. 下载并解压安装包到任意目录</p>
        <p>
          2. 安装 Node.js ≥ 22；adb / go-ios 已装可忽略，否则运行
          <code>adh-agent init</code> 从安装包内置资源解压（无需联网）
        </p>
        <p>3. 执行上面的接入命令，设备会在 5 秒内出现在「设备管理」</p>
      </div>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button type="primary" @click="close">我已完成</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.key-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.label {
  font-size: 12px;
  color: var(--text-dim);
}

.code-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.code {
  flex: 1;
  margin: 0;
  padding: 11px 13px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #15803d;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}

.steps {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.9;
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

.steps p {
  margin: 0;
}

.steps code {
  background: var(--surface-2);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  color: var(--text);
}
</style>