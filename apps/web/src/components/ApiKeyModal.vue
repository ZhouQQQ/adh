<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NModal,
  NPopconfirm,
  NSpin,
  useMessage,
} from 'naive-ui';
import { api, type ApiKeyRecord } from '../api';
import { cacheApiKey, readCachedApiKey } from '../api-key-cache';
import { useAuth } from '../stores/auth';

/**
 * 个人 API Key 管理弹窗。
 *
 * 入口在右上角个人信息下拉里，和「修改密码」并列。服务端会回显明文，
 * 所以打开就能直接复制 MCP 配置用的 url，不需要重置。
 */
const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>();

const show = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
});

const message = useMessage();
const { user, loadMe } = useAuth();

const keys = ref<ApiKeyRecord[]>([]);
const key = ref('');
const loading = ref(false);
const creating = ref(false);

const current = computed(() => keys.value[0] ?? null);

function formatTime(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadKeys(): Promise<void> {
  loading.value = true;
  try {
    if (!user.value) await loadMe();
    const data = await api.listApiKeys();
    keys.value = data.keys;
    if (data.key) {
      key.value = data.key;
      cacheApiKey(user.value?.id, data.key);
    } else {
      key.value = readCachedApiKey(user.value?.id);
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '加载 Key 失败');
  } finally {
    loading.value = false;
  }
}

async function resetKey(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  try {
    const result = await api.resetApiKey();
    key.value = result.key;
    cacheApiKey(user.value?.id, result.key);
    await loadKeys();
    message.success('已重置 Key');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重置失败');
  } finally {
    creating.value = false;
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch {
    message.warning('复制失败，请手动选择文本');
  }
}

watch(
  () => props.show,
  (open) => {
    if (open) void loadKeys();
  },
  { immediate: true },
);
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    title="个人 API Key"
    style="width: 560px"
    :bordered="false"
  >
    <n-spin :show="loading">
      <p class="hint">
        供 MCP 客户端和外部 agent 使用，每位用户只有一把默认 Key。
      </p>

      <div class="field-label">当前 Key</div>
      <div class="key-row">
        <code>{{ key || '（加载中…）' }}</code>
        <n-button
          size="tiny"
          :disabled="!key"
          @click="copy(key)"
        >
          复制
        </n-button>
      </div>

      <div v-if="current" class="meta">
        创建 {{ formatTime(current.createdAt) }}
        <template v-if="current.lastUsedAt">
          · 最近使用 {{ formatTime(current.lastUsedAt) }}
        </template>
        <template v-else> · 从未使用</template>
      </div>
    </n-spin>

    <template #footer>
      <div class="footer">
        <n-button size="small" @click="show = false">关闭</n-button>
        <n-popconfirm
          positive-text="重置"
          negative-text="取消"
          @positive-click="resetKey"
        >
          <template #trigger>
            <n-button size="small" type="primary" :loading="creating">
              重置 Key
            </n-button>
          </template>
          重置后旧 Key 立即失效，确认继续？
        </n-popconfirm>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.field-label {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-faint);
}

.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-row code {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11px;
  word-break: break-all;
}

.meta {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
