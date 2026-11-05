<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { NButton, NInput, NSpin, NTag } from 'naive-ui';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, type AiChatMessage, type AiChatStep } from '../api';

const props = defineProps<{
  deviceId: string;
  /** 只读观看者 / 未取得控制权时为 true。 */
  disabled?: boolean;
  /** 管理员是否已经启用并配置了模型。 */
  available?: boolean;
}>();

const emit = defineEmits<{ (event: 'close'): void }>();

type TimelineStep = AiChatStep;

const messages = ref<AiChatMessage[]>([]);
const steps = ref<TimelineStep[]>([]);
const input = ref('');
const running = ref(false);
const stopping = ref(false);
const status = ref('');
const errorText = ref('');
const listRef = ref<HTMLElement | null>(null);
let abort: AbortController | null = null;

/** 从服务端恢复这台设备的历史对话，刷新 / 换浏览器都不会丢。 */
async function loadHistory(): Promise<void> {
  if (!props.deviceId) return;
  try {
    const result = await api.getAiMessages(props.deviceId);
    messages.value = result.messages;
  } catch {
    /* 未登录或读取失败时保持空，不影响继续对话 */
  }
}

onMounted(() => {
  void loadHistory();
});

watch(
  () => props.deviceId,
  () => {
    void loadHistory();
  },
);

const canSend = computed(
  () =>
    !props.disabled &&
    props.available !== false &&
    !running.value &&
    input.value.trim().length > 0,
);

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const element = listRef.value;
  if (element) element.scrollTop = element.scrollHeight;
}

watch(
  [messages, steps, status],
  () => {
    void scrollToBottom();
  },
  { deep: true },
);

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}

const STEP_LABELS: Record<string, string> = {
  plan: '制定计划',
  tap: '点击',
  swipe: '滑动',
  input_text: '输入文字',
  press_key: '按键',
  wait: '等待',
  done: '完成',
  launch_app: '启动应用',
};

function stepLabel(name: string): string {
  return STEP_LABELS[name] ?? name;
}

function planStepsOf(step: AiChatStep): string[] {
  const raw = step.args?.steps;
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : [];
}

/** AI 回复按 Markdown 渲染，同时用 DOMPurify 过滤 HTML。 */
function renderMarkdown(content: string): string {
  try {
    const parsed = marked.parse(content, { async: false });
    return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : content);
  } catch {
    return content;
  }
}

async function send(): Promise<void> {
  if (!canSend.value) return;
  const text = input.value.trim();
  input.value = '';
  errorText.value = '';
  status.value = '';
  steps.value = [];
  messages.value = [...messages.value, { role: 'user', content: text }];

  running.value = true;
  stopping.value = false;
  abort = new AbortController();
  const controller = abort;
  let assistantReplied = false;

  try {
    await api.aiChat(
      props.deviceId,
      text,
      (event) => {
        if (event.type === 'saved') {
          // 服务端落库后回传真实 id，给刚发的消息绑定，刷新前也能删
          let target = -1;
          for (let i = messages.value.length - 1; i >= 0; i -= 1) {
            const item = messages.value[i];
            if (item?.role === event.role && !item.id) {
              target = i;
              break;
            }
          }
          if (target >= 0) {
            messages.value = messages.value.map((item, index) =>
              index === target ? { ...item, id: event.id } : item,
            );
          }
          return;
        }
        if (event.type === 'status') {
          status.value = event.message;
          return;
        }
        if (event.type === 'tool') {
          steps.value = [
            ...steps.value,
            { name: event.name, args: event.args },
          ];
          return;
        }
        if (event.type === 'tool_result') {
          const last = steps.value[steps.value.length - 1];
          if (last && last.name === event.name && last.detail === undefined) {
            steps.value = [
              ...steps.value.slice(0, -1),
              { ...last, detail: event.detail, ok: event.ok },
            ];
          }
          return;
        }
        if (event.type === 'reply') {
          assistantReplied = true;
          // 把本轮步骤固化到消息上，之后由服务端历史恢复
          messages.value = [
            ...messages.value,
            {
              role: 'assistant',
              content: event.content,
              steps: steps.value.map((step) => ({ ...step })),
            },
          ];
          steps.value = [];
          return;
        }
        if (event.type === 'error') {
          errorText.value = event.message;
        }
      },
      controller.signal,
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      errorText.value =
        error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (abort === controller) abort = null;
    // 前端强制断开（网络异常 / 3 秒兜底 / 清空）时服务端的 reply 收不到，
    // 本地补一条，保留已执行步骤，刷新后会由服务端历史替换。
    if (controller.signal.aborted && !assistantReplied) {
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          content: '用户已取消',
          steps: steps.value.map((step) => ({ ...step })),
        },
      ];
    }
    running.value = false;
    stopping.value = false;
    status.value = '';
    steps.value = [];
  }
}

async function stop(): Promise<void> {
  if (!running.value || stopping.value) return;
  stopping.value = true;
  status.value = '正在取消…';
  try {
    await api.cancelAi(props.deviceId);
  } catch {
    abort?.abort();
    return;
  }
  // 不立即断开 SSE：让服务端把「用户已取消」作为 reply / saved 发回来，
  // 超时仍未结束再强制断开兜底。
  setTimeout(() => {
    if (running.value) abort?.abort();
  }, 3_000);
}

async function removeMessage(message: AiChatMessage): Promise<void> {
  if (running.value || !message.id) return;
  try {
    await api.deleteAiMessage(props.deviceId, message.id);
    messages.value = messages.value.filter((item) => item.id !== message.id);
  } catch (error) {
    errorText.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function clear(): Promise<void> {
  if (running.value) {
    // 先断开当前 SSE，再取消服务端任务；等它把取消结果落库后再清空，
    // 避免清空后又被 finally 写入一条「用户已取消」。
    abort?.abort();
    try {
      await api.cancelAi(props.deviceId);
    } catch {
      /* 服务端可能已经结束 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  try {
    await api.clearAiMessages(props.deviceId);
  } catch {
    /* 清空失败时仍清理本地显示 */
  }
  messages.value = [];
  steps.value = [];
  errorText.value = '';
}
</script>

<template>
  <div class="ai-panel">
    <header class="ai-header">
      <div class="ai-title">AI 助手</div>
      <div class="ai-header-actions">
        <n-button quaternary size="tiny" :disabled="running" @click="clear">
          清空
        </n-button>
        <n-button quaternary size="tiny" @click="emit('close')">关闭</n-button>
      </div>
    </header>

    <div v-if="disabled" class="ai-notice">
      只有当前设备的控制者可以使用 AI 助手。
    </div>
    <div v-else-if="available === false" class="ai-notice">
      AI 助手尚未启用。请超级管理员在「系统设置 → AI 助手」中填写模型地址、API Key 和模型名称。
    </div>

    <div ref="listRef" class="ai-messages">
      <div v-if="!messages.length && !running" class="ai-empty">
        用自然语言描述要执行的操作，例如「打开设置，把蓝牙关掉」。
      </div>

      <div
        v-for="(message, index) in messages"
        :key="`msg-${index}`"
        class="ai-message"
        :class="message.role"
      >
        <div
          v-if="message.role === 'assistant'"
          class="ai-bubble markdown"
          v-html="renderMarkdown(message.content)"
        />
        <div v-else class="ai-bubble">{{ message.content }}</div>

        <div v-if="message.steps?.length" class="ai-steps">
          <div class="ai-steps-title">执行步骤</div>
          <div
            v-for="(step, stepIndex) in message.steps"
            :key="`msg-${index}-step-${stepIndex}`"
            class="ai-step"
            :class="{ 'is-plan': step.name === 'plan' }"
          >
            <span class="ai-step-index">{{ stepIndex + 1 }}</span>
            <template v-if="step.name === 'plan'">
              <div class="ai-plan">
                <div class="ai-plan-title">执行计划</div>
                <ol class="ai-plan-list">
                  <li v-for="(item, planIndex) in planStepsOf(step)" :key="planIndex">
                    {{ item }}
                  </li>
                </ol>
              </div>
            </template>
            <template v-else>
              <span class="ai-step-name">{{ stepLabel(step.name) }}</span>
              <span v-if="describeArgs(step.args)" class="ai-step-args">
                {{ describeArgs(step.args) }}
              </span>
              <n-tag
                v-if="step.detail !== undefined"
                size="tiny"
                :type="step.ok === false ? 'error' : 'success'"
                :bordered="false"
              >
                {{ step.detail }}
              </n-tag>
            </template>
          </div>
        </div>

        <div class="ai-msg-actions">
          <button
            v-if="message.id && !running"
            type="button"
            class="ai-delete"
            title="删除这条对话"
            @click="removeMessage(message)"
          >
            删除
          </button>
        </div>
      </div>

      <div v-if="steps.length" class="ai-steps">
        <div class="ai-steps-title">执行步骤</div>
        <div
          v-for="(step, index) in steps"
          :key="`step-${index}`"
          class="ai-step"
          :class="{ 'is-plan': step.name === 'plan' }"
        >
          <span class="ai-step-index">{{ index + 1 }}</span>
          <template v-if="step.name === 'plan'">
            <div class="ai-plan">
              <div class="ai-plan-title">执行计划</div>
              <ol class="ai-plan-list">
                <li v-for="(item, planIndex) in planStepsOf(step)" :key="planIndex">
                  {{ item }}
                </li>
              </ol>
            </div>
          </template>
          <template v-else>
            <span class="ai-step-name">{{ stepLabel(step.name) }}</span>
            <span v-if="describeArgs(step.args)" class="ai-step-args">
              {{ describeArgs(step.args) }}
            </span>
            <n-tag
              v-if="step.detail !== undefined"
              size="tiny"
              :type="step.ok === false ? 'error' : 'success'"
              :bordered="false"
            >
              {{ step.detail }}
            </n-tag>
          </template>
        </div>
      </div>

      <div v-if="running" class="ai-status">
        <n-spin :size="14" />
        <span>{{ status || '正在思考…' }}</span>
      </div>

      <div v-if="errorText" class="ai-error">{{ errorText }}</div>
    </div>

    <footer class="ai-footer">
      <n-input
        v-model:value="input"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 4 }"
        placeholder="描述任务，或直接问当前界面的情况…"
        :disabled="disabled"
        @keydown.enter.exact.prevent="send"
      />
      <div class="ai-footer-actions">
        <span class="ai-hint">Enter 发送 · Shift+Enter 换行</span>
        <n-button
          v-if="running"
          size="small"
          type="error"
          ghost
          :loading="stopping"
          @click="stop"
        >
          {{ stopping ? '取消中…' : '停止' }}
        </n-button>
        <n-button
          v-else
          size="small"
          type="primary"
          :disabled="!canSend"
          @click="send"
        >
          发送
        </n-button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.ai-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.ai-header-actions {
  display: flex;
  gap: 2px;
}

.ai-notice {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.ai-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-empty {
  margin: auto 0;
  padding: 24px 8px;
  text-align: center;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-faint);
}

.ai-message {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-message.user {
  align-items: flex-end;
}

.ai-msg-actions {
  display: flex;
  justify-content: flex-end;
  min-height: 14px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.ai-message:hover .ai-msg-actions {
  opacity: 1;
}

.ai-delete {
  border: none;
  background: none;
  padding: 0;
  font-size: 10px;
  color: var(--text-faint);
  cursor: pointer;
}

.ai-delete:hover {
  color: #dc2626;
}

.ai-bubble {
  max-width: 88%;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
}

/* AI 回复：Markdown 需要正常换行，而不是保留原文换行 */
.ai-bubble.markdown {
  max-width: 92%;
  white-space: normal;
}

.ai-bubble.markdown :deep(p) {
  margin: 0 0 8px;
}

.ai-bubble.markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.ai-bubble.markdown :deep(ul),
.ai-bubble.markdown :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 20px;
}

.ai-bubble.markdown :deep(li) {
  margin: 2px 0;
}

.ai-bubble.markdown :deep(strong) {
  font-weight: 600;
}

.ai-bubble.markdown :deep(h1),
.ai-bubble.markdown :deep(h2),
.ai-bubble.markdown :deep(h3) {
  margin: 10px 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.ai-bubble.markdown :deep(code) {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.06);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.ai-bubble.markdown :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #18181b;
  color: #e4e4e7;
  overflow-x: auto;
}

.ai-bubble.markdown :deep(pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
}

.ai-bubble.markdown :deep(a) {
  color: #2563eb;
  text-decoration: underline;
}

.ai-bubble.markdown :deep(blockquote) {
  margin: 6px 0;
  padding-left: 10px;
  border-left: 3px solid var(--border);
  color: var(--text-dim);
}

.ai-bubble.markdown :deep(table) {
  width: 100%;
  margin: 6px 0;
  border-collapse: collapse;
  font-size: 12px;
}

.ai-bubble.markdown :deep(th),
.ai-bubble.markdown :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--border);
  text-align: left;
}

.ai-bubble.markdown :deep(hr) {
  margin: 10px 0;
  border: none;
  border-top: 1px solid var(--border);
}

.ai-message.user .ai-bubble {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}

.ai-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.ai-steps-title {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 2px;
}

.ai-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
  flex-wrap: wrap;
}

.ai-step.is-plan {
  align-items: flex-start;
}

.ai-plan {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(37, 99, 235, 0.06);
}

.ai-plan-title {
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}

.ai-plan-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
}

.ai-step-index {
  width: 14px;
  height: 14px;
  line-height: 14px;
  text-align: center;
  border-radius: 50%;
  background: var(--border);
  color: var(--text-muted);
  flex: none;
}

.ai-step-name {
  font-weight: 600;
  color: var(--text);
}

.ai-step-args {
  color: var(--text-faint);
  word-break: break-all;
}

.ai-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.ai-error {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: #b91c1c;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.2);
  word-break: break-word;
}

.ai-footer {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--border);
}

.ai-footer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}

.ai-hint {
  font-size: 11px;
  color: var(--text-faint);
}
</style>