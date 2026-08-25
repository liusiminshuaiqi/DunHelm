import { Card, CardHead, KpiStat, StatusBadge, StatusDot, ErrorBanner, Skeleton, KpiSkeleton, ListSkeleton } from "@/components/ui/primitives";
import { Server, Boxes, Cpu, MemoryStick } from "lucide-react";
import { useOverview } from "@/data/useLive";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface rounded-md border border-line shadow-sh-2 px-3 py-2 text-[11px]">
      <div className="font-mono text-ink-400 mb-1.5">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-ink-500">{p.name}</span>
          <span className="ml-auto font-semibold text-ink-900 tabular-nums">{p.value}%</span>
        </div>
      ))}
    </div>
  );
}

export function Overview() {
  const ov = useOverview();
  const { cluster, trend: trend24h, namespaces, nodes, events } = ov;
  const loading = "_loading" in ov && (ov as { _loading?: boolean })._loading === true;
  const permDenied = "_permDenied" in ov && (ov as { _permDenied?: boolean })._permDenied === true;
  return (
    <div className="top-aura relative p-5 space-y-4">
      {("_error" in ov) && <ErrorBanner msg={(ov as any)._error} />}
      {permDenied && <ErrorBanner msg="当前账号无该集群的访问权限，暂无数据展示" title="无集群访问权限" hint="当前账号未被授权访问该集群，已清空展示数据。" />}
      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {loading ? (
          <>
            <div className="rise-1"><KpiSkeleton label="集群节点" icon={<Server size={15} />} accent="brand" /></div>
            <div className="rise-2"><KpiSkeleton label="运行 Pod" icon={<Boxes size={15} />} accent="cyan" /></div>
            <div className="rise-3"><KpiSkeleton label="CPU 使用" icon={<Cpu size={15} />} accent="ok" /></div>
            <div className="rise-4"><KpiSkeleton label="内存使用" icon={<MemoryStick size={15} />} accent="warn" /></div>
          </>
        ) : (
          <>
            <div className="rise-1"><KpiStat label="集群节点" value={cluster.nodes} unit="台" delta={permDenied ? undefined : "+2 本周"} deltaUp icon={<Server size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiStat label="运行 Pod" value={cluster.pods} unit="个" delta={permDenied ? undefined : "+38 本周"} deltaUp icon={<Boxes size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiStat label="CPU 使用" value={`${cluster.cpuUsed}`} unit={`/ ${cluster.cpuTotal} cores`} delta={permDenied ? undefined : "+6.2%"} deltaUp={false} icon={<Cpu size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiStat label="内存使用" value={`${cluster.memUsed}`} unit={`/ ${cluster.memTotal} Gi`} delta={permDenied ? undefined : "+3.1%"} deltaUp={false} icon={<MemoryStick size={18} />} accent="warn" /></div>
          </>
        )}
      </div>

      {/* 趋势 + 命名空间 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2 rise-2">
          <CardHead
            title="资源使用趋势"
            sub="过去 24 小时 · 集群整体"
            right={
              <div className="flex items-center gap-3 text-[11px]">
                <span className="flex items-center gap-1.5 text-ink-500"><span className="w-2.5 h-2.5 rounded-sm bg-brand-500" />CPU</span>
                <span className="flex items-center gap-1.5 text-ink-500"><span className="w-2.5 h-2.5 rounded-sm bg-cyan-500" />内存</span>
              </div>
            }
          />
          <div className="px-2 pb-3 h-[260px]">
            {loading ? (
              <div className="h-full grid place-items-center">
                <span className="text-[11.5px] text-ink-400 font-mono animate-pulse">加载 24h 资源趋势…</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend24h} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gCpu" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2478E8" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#2478E8" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gMem" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06B6D4" stopOpacity={0.26} />
                      <stop offset="100%" stopColor="#06B6D4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#EEF3F9" vertical={false} />
                  <XAxis dataKey="h" tick={{ fontSize: 10, fill: "#8492A9" }} tickLine={false} axisLine={false} interval={3} />
                  <YAxis tick={{ fontSize: 10, fill: "#8492A9" }} tickLine={false} axisLine={false} unit="%" domain={[0, 100]} />
                  <Tooltip content={<TrendTooltip />} cursor={{ stroke: "#8CBBF7", strokeDasharray: "3 3" }} />
                  <Area type="monotone" dataKey="cpu" name="CPU" stroke="#2478E8" strokeWidth={2} fill="url(#gCpu)" />
                  <Area type="monotone" dataKey="mem" name="内存" stroke="#06B6D4" strokeWidth={2} fill="url(#gMem)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="rise-3">
          <CardHead title="命名空间配额" sub="CPU / 内存 / Pod 占用" />
          <div className="px-4 pb-4 space-y-3">
            {loading && namespaces.length === 0 ? (
              <ListSkeleton rows={4} />
            ) : (
              namespaces.map((n) => (
                <div key={n.name}>
                  <div className="flex items-center justify-between text-[11.5px] mb-1">
                    <span className="font-mono text-ink-700">{n.name}</span>
                    <span className="text-ink-400 font-mono">{n.pods} pods</span>
                  </div>
                  <div className="space-y-1">
                    <Bar label="CPU" v={n.cpu} color="bg-brand-500" />
                    <Bar label="MEM" v={n.mem} color="bg-cyan-500" />
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* 节点 + 事件 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2 rise-4">
          <CardHead title="节点状态" sub={permDenied ? `${nodes.length} 个节点` : `${nodes.length} 个节点 · 1 个告警`} right={<span className="text-[11px] text-brand-600 font-medium cursor-pointer hover:underline">查看全部</span>} />
          <div className="px-2 pb-2 overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-ink-400 text-[11px] font-medium">
                  <th className="text-left font-medium px-3 py-2">节点</th>
                  <th className="text-left font-medium px-3 py-2">角色</th>
                  <th className="text-left font-medium px-3 py-2">状态</th>
                  <th className="text-right font-medium px-3 py-2">CPU</th>
                  <th className="text-right font-medium px-3 py-2">内存</th>
                  <th className="text-right font-medium px-3 py-2">Pods</th>
                  <th className="text-right font-medium px-3 py-2">版本</th>
                </tr>
              </thead>
              <tbody>
                {loading && nodes.length === 0 ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="border-t border-line">
                      {Array.from({ length: 7 }).map((__, j) => (
                        <td key={j} className="px-3 py-2"><Skeleton className="h-4 w-20" /></td>
                      ))}
                    </tr>
                  ))
                ) : (
                  nodes.map((n) => (
                    <tr key={n.name} className="border-t border-line hover:bg-subtle transition">
                      <td className="px-3 py-2">
                        <div className="font-mono text-ink-900">{n.name}</div>
                        <div className="font-mono text-[10px] text-ink-400">{n.ip}</div>
                      </td>
                      <td className="px-3 py-2 text-ink-500">{n.role}</td>
                      <td className="px-3 py-2"><StatusBadge kind={n.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-ink-700 tabular-nums">{n.cpu}%</td>
                      <td className="px-3 py-2 text-right font-mono text-ink-700 tabular-nums">{n.mem}%</td>
                      <td className="px-3 py-2 text-right font-mono text-ink-700 tabular-nums">{n.pods}</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-400">{n.version}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="rise-5">
          <CardHead title="实时事件" sub="集群事件流" right={<span className="flex items-center gap-1 text-[11px] text-ok"><span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse-ring" />live</span>} />
          <div className="px-3 pb-3 space-y-0.5 max-h-[300px] overflow-y-auto">
            {loading && events.length === 0 ? (
              <ListSkeleton rows={3} />
            ) : (
              events.map((e, i) => (
                <div key={i} className="flex gap-2.5 py-2 border-b border-line/70 last:border-0">
                  <span className="mt-1"><StatusDot kind={e.type} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-ink-900">{e.reason}</span>
                      <span className="font-mono text-[10px] text-ink-300">{e.time}</span>
                    </div>
                    <div className="font-mono text-[10.5px] text-brand-600 truncate">{e.obj}</div>
                    <div className="text-[11px] text-ink-500 truncate">{e.msg}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Bar({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-mono text-ink-400 w-7">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-sunken overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${v}%` }} />
      </div>
      <span className="text-[10px] font-mono text-ink-400 w-7 text-right tabular-nums">{v}%</span>
    </div>
  );
}
