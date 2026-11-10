<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NSpin, useMessage } from 'naive-ui';
import { api } from '../api';
import { BASE_PATH } from '../base';
import { cacheApiKey, readCachedApiKey } from '../api-key-cache';
import { useAuth } from '../stores/auth';

const message = useMessage();
const { user, loadMe } = useAuth();

const apiKey = ref('');
const loading = ref(true);

const serverUrl = computed(
  () => `${window.location.origin}${BASE_PATH}`,
);

const configExample = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'ADH 设备农场': {
          url: `${serverUrl.value}/mcp?key=${apiKey.value || 'adhk_xxx'}`,
        },
      },
    },
    null,
    2,
  ),
);

async function loadKey(): Promise<void> {
  try {
    if (!user.value) await loadMe();
    const data = await api.listApiKeys();
    if (data.key) {
      apiKey.value = data.key;
      cacheApiKey(user.value?.id, data.key);
    } else {
      apiKey.value = readCachedApiKey(user.value?.id);
    }
  } catch {
    /* 未登录时由全局 401 处理 */
  } finally {
    loading.value = false;
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
  void loadKey();
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
          系统已为每位用户自动生成默认 Key，并已填入下面的配置。
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
        <div class="step-title"><span>3</span> 可用工具</div>
        <p class="hint">
          Agent 会自动调用这些工具，多数情况下你只需要用自然语言描述目标。
        </p>
        <ul class="examples">
          <li><code>list_devices</code> 列出在线、未锁定、空闲的设备</li>
          <li><code>get_device</code> 查看单台设备详情、锁定状态和当前控制者</li>
          <li><code>run_task</code> 在指定或自动选择的设备上执行自然语言任务</li>
          <li><code>batch_task</code> 一句话拆成多台设备任务（自动判断并行 / 顺序）</li>
          <li><code>get_task</code> 查询任务状态、执行步骤和结果，含回放链接</li>
          <li><code>list_tasks</code> 列出最近创建的任务</li>
          <li><code>cancel_task</code> 取消单个任务</li>
          <li><code>cancel_all_tasks</code> 停掉当前用户所有未完成任务</li>
        </ul>
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
</style>