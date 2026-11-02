<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  useMessage,
} from 'naive-ui';
import type { AgentSummary } from '@adh/protocol';
import { api } from '../api';

const props = defineProps<{
  show: boolean;
  agent: AgentSummary | null;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  updated: [agent: AgentSummary];
}>();

const message = useMessage();
const name = ref('');
const submitting = ref(false);

watch(
  () => props.show,
  (visible) => {
    if (visible) name.value = props.agent?.name ?? '';
  },
);

async function submit(): Promise<void> {
  const current = props.agent;
  if (!current || submitting.value) return;

  const value = name.value.trim();
  if (!value) {
    message.warning('请填写 Agent 名称');
    return;
  }
  if (value === current.name) {
    emit('update:show', false);
    return;
  }

  submitting.value = true;
  try {
    const result = await api.updateAgent(current.id, value);
    emit('updated', result.agent);
    emit('update:show', false);
    message.success('已保存');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="编辑 Agent"
    style="width: 460px"
    @update:show="emit('update:show', $event)"
  >
    <n-form label-placement="top" @submit.prevent="submit">
      <n-form-item label="显示名称">
        <n-input
          v-model:value="name"
          placeholder="例如：上海机房-01"
          maxlength="40"
          show-count
          @keyup.enter="submit"
        />
      </n-form-item>
      <p class="hint">
        显示名称只影响控制台展示，不影响 Agent 的连接与 Key。
        <template v-if="agent?.hostName">
          宿主机上报的名称为「{{ agent.hostName }}」。
        </template>
      </p>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button quaternary @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submit">
          保存
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}
</style>