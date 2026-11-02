<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NDropdown,
  NIcon,
  NSpace,
  NTag,
  NText,
  useDialog,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import {
  AddOutline,
  EllipsisHorizontalOutline,
  RefreshOutline,
} from '@vicons/ionicons5';
import type { AgentSummary } from '@adh/protocol';
import AgentDetailDrawer from '../components/AgentDetailDrawer.vue';
import AgentKeyModal from '../components/AgentKeyModal.vue';
import CreateAgentModal from '../components/CreateAgentModal.vue';
import EditAgentModal from '../components/EditAgentModal.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
import { formatAgo } from '../utils/format';

const { agents, refresh } = useFleet();
const message = useMessage();
const dialog = useDialog();

const showCreate = ref(false);
const keyShow = ref(false);
const keyName = ref('');
const keyValue = ref('');
const keyIsNew = ref(true);

const detailShow = ref(false);
const detailAgentId = ref<string | null>(null);

const editShow = ref(false);
const editingAgent = ref<AgentSummary | null>(null);

function openDetail(row: AgentSummary): void {
  detailAgentId.value = row.id;
  detailShow.value = true;
}

function openEdit(row: AgentSummary): void {
  editingAgent.value = row;
  editShow.value = true;
}

function onUpdated(): void {
  void refresh();
}

const now = ref(Date.now());
let timer: number | undefined;
onMounted(() => {
  timer = window.setInterval(() => (now.value = Date.now()), 10_000);
});
onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});

function openKeyModal(name: string, key: string, isNew: boolean): void {
  keyName.value = name;
  keyValue.value = key;
  keyIsNew.value = isNew;
  keyShow.value = true;
}

function onCreate(agent: AgentSummary, key: string): void {
  openKeyModal(agent.name, key, true);
  void refresh();
}

const columns = computed<DataTableColumns<AgentSummary>>(() => [
  {
    title: '名称',
    key: 'name',
    minWidth: 150,
    render: (row) =>
      h(
        NSpace,
        { size: 6, align: 'center', wrap: false },
        {
          default: () => [
            h(NText, { strong: true }, { default: () => row.name }),
            row.builtin
              ? h(
                  NTag,
                  { size: 'tiny', type: 'info', bordered: false, round: true },
                  { default: () => '内置' },
                )
              : null,
          ],
        },
      ),
  },
  {
    title: '状态',
    key: 'status',
    width: 96,
    render: (row) => {
      const meta = row.online
        ? { type: 'success' as const, label: '在线' }
        : row.pending
          ? { type: 'warning' as const, label: '待接入' }
          : { type: 'default' as const, label: '离线' };
      return h(
        NTag,
        { size: 'small', type: meta.type, bordered: false, round: true },
        { default: () => meta.label },
      );
    },
  },
  {
    title: '运行环境',
    key: 'runtime',
    width: 170,
    render: (row) =>
      row.os
        ? `${row.os} / ${row.arch} · v${row.version}`
        : h('span', { style: 'color:var(--text-faint)' }, '尚未接入'),
  },
  {
    title: '能力',
    key: 'capabilities',
    width: 150,
    render: (row) =>
      row.capabilities.length === 0
        ? '—'
        : h(
            NSpace,
            { size: 4 },
            {
              default: () =>
                row.capabilities.map((capability) =>
                  h(
                    NTag,
                    { size: 'tiny', bordered: false },
                    { default: () => capability },
                  ),
                ),
            },
          ),
  },
  {
    title: '设备数',
    key: 'deviceCount',
    width: 78,
    align: 'right',
    render: (row) => String(row.deviceCount),
  },
  {
    title: 'Key',
    key: 'keyPreview',
    width: 190,
    render: (row) =>
      h(
        'code',
        { style: 'font-size:11px;color:var(--text-dim)' },
        row.keyPreview,
      ),
  },
  {
    title: '最后心跳',
    key: 'lastSeen',
    width: 110,
    render: (row) => formatAgo(row.lastSeen, now.value),
  },
  {
    title: '操作',
    key: 'actions',
    width: 112,
    render: (row) =>
      h(
        NSpace,
        { size: 2, justify: 'end', align: 'center', wrap: false },
        {
          default: () => [
            h(
              NButton,
              { size: 'tiny', quaternary: true, onClick: () => openDetail(row) },
              { default: () => '详情' },
            ),
            row.builtin
              ? null
              : h(
                  NDropdown,
                  {
                    trigger: 'click',
                    options: [
                      { label: '编辑名称', key: 'edit' },
                      { label: '重置 Key', key: 'rotate' },
                      { type: 'divider', key: 'divider' },
                      { label: '删除', key: 'delete' },
                    ],
                    onSelect: (key: string) => {
                      if (key === 'edit') openEdit(row);
                      else if (key === 'rotate') void rotateKey(row);
                      else if (key === 'delete') confirmDelete(row);
                    },
                  },
                  {
                    default: () =>
                      h(
                        NButton,
                        { size: 'tiny', quaternary: true, circle: true },
                        {
                          icon: () =>
                            h(NIcon, { component: EllipsisHorizontalOutline }),
                        },
                      ),
                  },
                ),
          ],
        },
      ),
  },
]);

async function rotateKey(row: AgentSummary): Promise<void> {
  dialog.warning({
    title: '重置接入 Key',
    content: `重置后「${row.name}」当前的连接会失效，需要用新 Key 重新接入。确定继续？`,
    positiveText: '重置',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await api.rotateAgentKey(row.id);
        openKeyModal(result.agent.name, result.key, false);
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '重置失败');
      }
    },
  });
}

function confirmDelete(row: AgentSummary): void {
  dialog.error({
    title: '删除 Agent',
    content: `确定删除「${row.name}」吗？其下 ${row.deviceCount} 台设备记录也会一并移除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteAgent(row.id);
        message.success('已删除');
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}
</script>

<template>
  <div class="agents-page">
    <div class="toolbar">
      <p class="hint">
        Agent 部署在设备宿主机上，负责发现本机连接的 Android / iOS 设备并上报。
        新建后复制命令到宿主机执行即可接入。
      </p>
      <n-space>
        <n-button quaternary size="small" @click="refresh">
          <template #icon>
            <n-icon :component="RefreshOutline" />
          </template>
        </n-button>
        <n-button type="primary" size="small" @click="showCreate = true">
          <template #icon>
            <n-icon :component="AddOutline" />
          </template>
          新建 Agent
        </n-button>
      </n-space>
    </div>

    <n-data-table
      :columns="columns"
      :data="agents"
      :bordered="false"
      :single-line="false"
      :row-key="(row: AgentSummary) => row.id"
      size="small"
    />

    <CreateAgentModal v-model:show="showCreate" @created="onCreate" />
    <AgentKeyModal
      v-model:show="keyShow"
      :agent-name="keyName"
      :agent-key="keyValue"
      :is-new="keyIsNew"
    />
    <AgentDetailDrawer v-model:show="detailShow" :agent-id="detailAgentId" />
    <EditAgentModal
      v-model:show="editShow"
      :agent="editingAgent"
      @updated="onUpdated"
    />
  </div>
</template>

<style scoped>
.agents-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

:deep(.n-data-table) {
  background: var(--surface);
  border-radius: 10px;
  border: 1px solid var(--border);
}
</style>