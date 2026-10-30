import { AgentList } from './components/AgentList';
import { DeviceGrid } from './components/DeviceGrid';
import { ConnectionBadge, Stat } from './components/HeaderBits';
import { useFleet } from './useFleet';

export default function App() {
  const { agents, devices, connection } = useFleet();
  const onlineAgents = agents.filter((agent) => agent.online).length;
  const onlineDevices = devices.filter((device) => device.status === 'online').length;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-emerald-500/15 text-sm font-bold text-emerald-300">
              ADH
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide">设备农场</h1>
              <p className="text-xs text-zinc-500">
                分布式 Android / iOS 设备管理
              </p>
            </div>
          </div>
          <div className="flex items-center gap-5">
            <Stat label="节点" value={`${onlineAgents}/${agents.length}`} />
            <Stat label="设备" value={`${onlineDevices}/${devices.length}`} />
            <ConnectionBadge state={connection} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-10 px-6 py-8">
        <AgentList agents={agents} />
        <DeviceGrid devices={devices} agents={agents} />
      </main>

      <footer className="mx-auto max-w-7xl px-6 pb-8 pt-2 text-[11px] text-zinc-600">
        M0 · 设备发现与实时看板
      </footer>
    </div>
  );
}