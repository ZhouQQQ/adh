<script setup lang="ts">
import { computed, ref } from 'vue';
import { NIcon, useMessage } from 'naive-ui';
import { CheckmarkOutline, CopyOutline } from '@vicons/ionicons5';
import { copyText } from '../utils/clipboard';

const props = defineProps<{
  value?: string | number | null;
  mono?: boolean;
  /** 只显示复制按钮，不显示文本（用于配合自定义展示）。 */
  iconOnly?: boolean;
}>();

const message = useMessage();
const copied = ref(false);

const display = computed(() => {
  const value = props.value;
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
});

const canCopy = computed(() => display.value !== '—');

async function copy(): Promise<void> {
  if (!canCopy.value) return;
  const ok = await copyText(display.value);
  if (ok) {
    copied.value = true;
    message.success('已复制');
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } else {
    message.error('复制失败，请手动选中');
  }
}
</script>

<template>
  <span class="copy-value" :class="{ 'icon-only': iconOnly }">
    <span v-if="!iconOnly" class="text" :class="{ mono }">{{ display }}</span>
    <button
      v-if="canCopy"
      class="copy-btn"
      type="button"
      title="复制"
      @click.stop="copy"
    >
      <n-icon :component="copied ? CheckmarkOutline : CopyOutline" :size="13" />
    </button>
  </span>
</template>

<style scoped>
.copy-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
}

.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.copy-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;
}

.copy-value:hover .copy-btn {
  opacity: 1;
}

.copy-value.icon-only .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--text);
  background: var(--surface-2);
}

@media (hover: none) {
  .copy-btn {
    opacity: 1;
  }
}
</style>