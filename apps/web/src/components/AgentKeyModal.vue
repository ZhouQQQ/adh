<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NIcon, NModal, NSpace, useMessage } from 'naive-ui';
import { CheckmarkOutline, CopyOutline } from '@vicons/ionicons5';
import { api } from '../api';
import { copyText } from '../utils/clipboard';
import { buildConnectCommand, buildSourceCommand } from '../utils/command';

const props = defineProps<{
  show: boolean;
  agentName: string;
  agentKey: string;
  isNew: boolean;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const serverPort = ref(8080);
const copied = ref<'command' | 'source' | null>(null);

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
const sourceCommand = computed(() =>
  buildSourceCommand(props.agentKey, serverPort.value),
);

async function copy(value: string, which: 'command' | 'source'): Promise<void> {
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
    :title="isNew ? `Agent「${agentName}」已创建` : `Agent「${agentName}」的 Key 已重置`"
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
        <span class="label">当前源码运行方式</span>
        <div class="code-row">
          <pre class="code muted">{{ sourceCommand }}</pre>
          <n-button size="small" quaternary @click="copy(sourceCommand, 'source')">
            <template #icon>
              <n-icon
                :component="copied === 'source' ? CheckmarkOutline : CopyOutline"
              />
            </template>
          </n-button>
        </div>
      </div>

      <div class="steps">
        <p>1. 在宿主机安装 Node.js ≥ 22 与 Android Platform Tools（adb）</p>
        <p>2. 先运行 <code>pnpm --filter @adh/agent dev doctor</code> 确认环境</p>
        <p>3. 执行上面的命令，设备会在 5 秒内出现在「设备管理」</p>
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
  color: #8a8a94;
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
  background: #101014;
  border: 1px solid #2a2a30;
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #63e2b7;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}

.code.muted {
  color: #8a8a94;
}

.steps {
  font-size: 12px;
  color: #6f6f78;
  line-height: 1.9;
}

.steps p {
  margin: 0;
}

.steps code {
  background: #232329;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  color: #c9c9d1;
}
</style>