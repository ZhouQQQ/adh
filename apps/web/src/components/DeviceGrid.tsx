import type { AgentSummary, DeviceSummary } from '@adh/protocol';
import { PlatformBadge, StatusPill } from './badges';
import { EmptyState, Section } from './Section';

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</dt>
      <dd className="truncate text-xs text-zinc-300" title={value}>
        {value && value.length > 0 ? value : '—'}
      </dd>
    </div>
  );
}

export function DeviceGrid({
  devices,
  agents,
}: {
  devices: DeviceSummary[];
  agents: AgentSummary[];
}) {
  const online = devices.filter((device) => device.status === 'online').length;
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

  return (
    <Section
      title="设备"
      description={`${online} 台可用 / 共 ${devices.length} 台`}
    >
      {devices.length === 0 ? (
        <EmptyState title="暂无设备">
          用 USB 连接 Android 设备并开启 USB 调试，节点会在 5 秒内自动发现。
          若显示为「未授权」，请在设备上确认调试授权弹窗。
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {devices.map((device) => (
            <article
              key={device.id}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <PlatformBadge platform={device.platform} />
                    <h3 className="truncate text-sm font-medium">{device.name}</h3>
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {device.model ?? '未知型号'}
                  </p>
                </div>
                <StatusPill status={device.status} />
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
                <Field label="系统版本" value={device.osVersion} />
                <Field
                  label="分辨率"
                  value={
                    device.resolution
                      ? `${device.resolution.width}×${device.resolution.height}`
                      : undefined
                  }
                />
                <Field label="节点" value={agentNames.get(device.agentId)} />
                <Field label="UDID" value={device.udid} />
              </dl>
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}