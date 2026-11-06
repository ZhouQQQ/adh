<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NSpin, useMessage } from 'naive-ui';
import { api, type ApiKeyRecord } from '../api';
import { BASE_PATH } from '../base';
import {
  cacheApiKey,
  readCachedApiKey,
} from '../api-key-cache';
import { useAuth } from '../stores/auth';

const message = useMessage();
const { user, loadMe } = useAuth();

const keys = ref<ApiKeyRecord[]>([]);
const newKey = ref('');
const loading = ref(true);
const creating = ref(false);

const serverUrl = computed(
  () => `${window.location.origin}${BASE_PATH}`,
);

const configExample = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'ADH 设备农场': {
          url: `${serverUrl.value}/mcp?key=${newKey.value || 'adhk_xxx'}`,
        },
      },
    },
    null,
    2,
  ),
);

function formatTime(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadKeys(): Promise<void> {
  try {
    if (!user.value) await loadMe();
    const data = await api.listApiKeys();
    keys.value = data.keys;
    if (data.key) {
      // 首次进入自动生成，明文只在这里返回一次
      newKey.value = data.key;
      cacheApiKey(user.value?.id, data.key);
    } else if (!newKey.value) {
      newKey.value = readCachedApiKey(user.value?.id);
    }
  } catch {
    /* 未登录时由全局 401 处理 */
  } finally {
    loading.value = false;
  }
}

async function resetKey(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  try {
    const result = await api.resetApiKey();
    newKey.value = result.key;
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

onMounted(() => {
  void loadKeys();
});
</script>

<template>
  <div class="mcp-page">
    <n-spin :show="loading">
      <header class="mcp-header">
        <h2>ADH 设备农场 · MCP 接入</h2>
        <p>
          把设备农场接入 Codex、Claude Code、DeepSeek harness 等支持 MCP
          的 agent。系统会为每位用户自动生成 Key，agent 就能自动选择空闲设备并执行自然语言任务。
        </p>
      </header>

      <section class="mcp-card">
        <div class="step-title"><span>1</span> 配置 MCP 客户端</div>
        <p class="hint">
          系统已为每位用户自动生成 Key，并已填入下面的配置。
          把 <code>url</code> 填到支持 Streamable HTTP 的 MCP 客户端
          （Claude Desktop、Codex、Cursor、Cherry Studio 等）。不需要 Node
          进程，也不需要仓库路径。
        </p>
        <pre class="code-block">{{ configExample }}</pre>
        <n-button size="tiny" @click="copy(configExample)">复制配置</n-button>
      </section>

      <section class="mcp-card">
        <div class="step-title"><span>2</span> 开始使用</div>
        <p class="hint">
          配置完成后，直接对 agent 说：
        </p>
        <ul class="examples">
          <li>「帮我在安卓上打开微信，进入某个小程序，完成登录注册」</li>
          <li>「把所有标签为 regression 的设备打开设置，关掉蓝牙」</li>
          <li>「找一台空闲的 iOS 设备，打开设置看一下版本号」</li>
        </ul>
      </section>

      <section class="mcp-card">
        <div class="step-title"><span>3</span> 重置 Key</div>
        <p class="hint">
          系统已为每位用户维护一把默认 Key，上面的配置会自动填入。
          换设备或清缓存后，点下面的「重置 Key」会删除旧 Key 并创建一把新的。
        </p>

        <div v-if="newKey" class="reveal">
          <div class="reveal-label">当前 Key（已保存在本浏览器）</div>
          <div class="reveal-row">
            <code>{{ newKey }}</code>
            <n-button size="tiny" @click="copy(newKey)">复制</n-button>
          </div>
        </div>

        <p v-if="!newKey && keys.length" class="hint">
          当前账号已有 Key，但明文只在创建时显示。点下面的「重置 Key」获取新的。
        </p>

        <div v-if="!keys.length" class="hint">还没有 API Key。</div>
        <div v-for="key in keys" :key="key.id" class="key-row">
          <div class="key-meta">
            <strong>{{ key.name }}</strong>
            <span>
              {{ key.prefix }}… · 创建 {{ formatTime(key.createdAt) }}
              <template v-if="key.lastUsedAt">
                · 最近使用 {{ formatTime(key.lastUsedAt) }}
              </template>
            </span>
          </div>
        </div>

        <div class="row" style="margin-top: 12px">
          <n-button
            type="primary"
            size="small"
            :loading="creating"
            @click="resetKey"
          >
            重置 Key
          </n-button>
        </div>
      </section>
    </n-spin>
  </div>
</template>

<style scoped>
.mcp-page {
  max-width: 880px;
  margin: 0 auto;
  padding: 8px 0 40px;
}

.mcp-header h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}

.mcp-header p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.mcp-card {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.step-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.step-title span {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #18181b;
  color: #fafafa;
  font-size: 10px;
}

.hint {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.reveal {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}

.reveal-label {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-faint);
}

.reveal-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reveal-row code {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11px;
  word-break: break-all;
}

.code-block {
  margin: 8px 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.65;
  overflow-x: auto;
  white-space: pre;
}

.examples {
  margin: 6px 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.9;
  color: var(--text-muted);
}

.key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px dashed var(--border);
}

.key-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.key-meta strong {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.key-meta span {
  font-size: 11px;
  color: var(--text-faint);
  word-break: break-all;
}
</style>