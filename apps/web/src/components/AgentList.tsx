import type { AgentSummary } from '@adh/protocol';
import { formatAgo, useNow } from '../useNow';
import { AgentOnlineDot } from './badges';
import { EmptyState, Section } from './Section';

export function AgentList({ agents }: { agents: AgentSummary[] }) {
  const now = useNow();
  const online = agents.filter((agent) => agent.online).length;

  return (
    <Section
      title="接入节点"
      description={`${online} 台在线 / 共 ${agents.length} 台`}
    >
      {agents.length === 0 ? (
        <EmptyState title="还没有节点接入">
          在设备宿主机上运行{' '}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
            adh-agent connect --server ws://&lt;本机IP&gt;:8080 --code &lt;注册码&gt;
          </code>
          <br />
          注册码见 adh-server 启动日志。
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <article
              key={agent.id}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <AgentOnlineDot agent={agent} />
                  <h3 className="truncate text-sm font-medium">{agent.name}</h3>
                </div>
                <span className="shrink-0 text-[11px] text-zinc-500">
                  {agent.online ? '在线' : formatAgo(agent.lastSeen, now)}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {agent.os} · {agent.arch} · v{agent.version}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {agent.capabilities.length === 0 ? (
                  <span className="text-[11px] text-zinc-600">未报告能力</span>
                ) : (
                  agent.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400"
                    >
                      {capability}
                    </span>
                  ))
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}