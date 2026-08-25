import { useState, useEffect } from "react";
import { Card, StatusBadge, SectionTitle, MiniGauge, KpiStat, Modal, Field, TextInput, SelectInput, ErrorBanner, TableSkeleton, KpiSkeleton } from "@/components/ui/primitives";
import { useNodes } from "@/data/useLive";
import { nodePods, type NodePod, nodeExporterStatus, nodeExporterInstall, type NodeExporterStatus, metricsServerStatus, metricsServerInstall, type MetricsServerStatus } from "@/lib/api";
import { getCluster, subscribeCluster } from "@/lib/cluster";
import { cn } from "@/lib/utils";
import { Server, Cpu, MemoryStick, Search, Plus, RefreshCw, ShieldCheck, Filter, Boxes, AlertTriangle } from "lucide-react";

const tone = (v: number): "ok" | "warn" | "err" => (v > 92 ? "err" : v > 85 ? "warn" : "ok");
const statusLabel: Record<string, string> = {
  ok: "Ready", warn: "Pressure", updating: "Scheduling", err: "NotReady",
};
const roleLabel: Record<string, { t: string; c: string }> = {
  "control-plane": { t: "control-plane", c: "bg-info-bg text-info" },
  worker: { t: "worker", c: "bg-idle-bg text-idle" },
};

// Pod 状态 → 徽章色调
// 后端 Pod 状态串：ok / updating / pending / err / Terminating（外加 kubelet Reason 小写值）
const podTone = (s: string): "ok" | "warn" | "err" | "idle" =>
  s === "ok" || s === "running" ? "ok"
  : s === "updating" || s === "pending" ? "warn"
  : s === "Completed" || s === "Terminating" ? "idle"
  : "err";

// 资源单元格：未就绪时显示「未就绪」而非误导性的 0%
function ResCell({ label, value, ready, hint }: { label: string; value: number; ready: boolean; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="text-[10.5px] text-ink-400 mb-1.5">{label}</div>
      {ready ? (
        <MiniGauge value={value} tone={tone(value)} />
      ) : (
        <span className="text-[10.5px] text-ink-300 italic" title={hint}>{value > 0 ? `${value}%` : "未就绪"}</span>
      )}
    </div>
  );
}

// 表格内的使用率单元格：未检测到 metrics-server 时显示「未就绪」，避免误导性的 0%
function UsageCell({ value, ready }: { value: number; ready: boolean }) {
  if (!ready) {
    return (
      <span className="text-[10.5px] text-ink-300 italic" title="未检测到 metrics-server，无法获取实时使用率">
        未就绪
      </span>
    );
  }
  return <MiniGauge value={value} tone={tone(value)} />;
}

type NodeRow = {
  name: string;
  role: string;
  status: string;
  cpu: number;
  mem: number;
  disk: number;
  diskRoot?: number;
  diskData?: number;
  diskDataFound?: boolean;
  diskReady?: boolean;
  pods: number;
  podTotal: number;
  ip: string;
  os: string;
  version: string;
  age: string;
};

export function Nodes() {
  const live = useNodes();
  const loading = (live as any)._loading === true;
  const nodes = live.nodes as NodeRow[];
  const metricsReady: boolean = !!(live as any).kpi?.metricsReady;
  const diskReadyAgg: boolean = !!(live as any).kpi?.diskReady;
  const { total, ready, cpuRate: cpuAvg, memRate: memAvg } = live.kpi;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", ip: "", role: "worker", os: "Ubuntu 22.04" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // 节点详情：点击行打开，展示该节点承载的所有 Pod
  const [selected, setSelected] = useState<NodeRow | null>(null);
  const [npods, setNPods] = useState<NodePod[]>([]);
  const [npLoading, setNPLoading] = useState(false);
  const [npError, setNPError] = useState<string | null>(null);
  const [npSearch, setNPSearch] = useState("");

  // 节点监控数据源状态：node-exporter（磁盘）+ metrics-server（CPU/内存）。
  // 两者独立、互不替代；未安装时提示一键安装，安装后轮询至两者均就绪。
  const [nx, setNx] = useState<NodeExporterStatus | null>(null);
  const [ms, setMs] = useState<MetricsServerStatus | null>(null);
  const [nxLoading, setNxLoading] = useState(false);
  const [monitorInstalling, setMonitorInstalling] = useState(false);
  const [monitorMsg, setMonitorMsg] = useState<string | null>(null);

  const loadStatus = () => {
    const cluster = getCluster();
    if (!cluster) {
      setNx(null);
      setMs(null);
      return;
    }
    setNxLoading(true);
    Promise.all([nodeExporterStatus(cluster), metricsServerStatus(cluster)])
      .then(([d, m]) => {
        setNx(d);
        setMs(m);
      })
      .catch(() => {
        setNx({ installed: false, ready: false, message: "", pods: [] });
        setMs({ installed: false, ready: false, message: "" });
      })
      .finally(() => setNxLoading(false));
  };

  useEffect(() => {
    loadStatus();
    return subscribeCluster(loadStatus);
  }, []);

  // 一键安装节点监控：同时部署 node-exporter（磁盘）与 metrics-server（CPU/内存），
  // 写一次集群，之后轮询两者状态直至均就绪，并刷新节点列表。
  const installMonitoring = () => {
    const cluster = getCluster();
    if (!cluster) return;
    setMonitorInstalling(true);
    setMonitorMsg(null);
    Promise.all([nodeExporterInstall(cluster), metricsServerInstall(cluster)])
      .then(([a]) => {
        setMonitorMsg(a.message || "已部署");
        // 轮询两者就绪（最多 ~36s）
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          Promise.all([nodeExporterStatus(cluster), metricsServerStatus(cluster)])
            .then(([s, m]) => {
              setNx(s);
              setMs(m);
              if ((s.ready && m.ready) || tries >= 12) {
                clearInterval(timer);
                setMonitorInstalling(false);
                live.reload?.();
              }
            })
            .catch(() => {
              if (tries >= 12) {
                clearInterval(timer);
                setMonitorInstalling(false);
              }
            });
        }, 3000);
      })
      .catch((e: Error) => {
        setMonitorInstalling(false);
        setMonitorMsg("部署失败：" + e.message);
      });
  };

  useEffect(() => {
    if (!selected) return;
    const cluster = getCluster();
    if (!cluster) return;
    setNPSearch("");
    setNPLoading(true);
    setNPError(null);
    nodePods(cluster, selected.name)
      .then((d) => setNPods(d.pods))
      .catch((e: Error) => setNPError(e.message))
      .finally(() => setNPLoading(false));
  }, [selected]);

  return (
    <div className="top-aura relative p-5 space-y-4">
      {("_error" in live) && <ErrorBanner msg={(live as any)._error} />}
      {((live as any)._permDenied) && <ErrorBanner msg="当前账号无该集群的访问权限，暂无数据展示" title="无集群访问权限" hint="当前账号未被授权访问该集群，已清空展示数据。" />}
      <SectionTitle
        title="集群节点"
        desc={loading ? "正在从集群加载节点…" : `${total} 个节点 · ${ready} 个就绪 · Kubernetes v1.29.4`}
        right={
          <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">
            <Plus size={15} /> 添加节点
          </button>
        }
      />

      {/* 节点监控安装横幅：磁盘（node-exporter）或 CPU/内存（metrics-server）任一未就绪时引导一键安装（仅安装时写一次集群） */}
      {(!diskReadyAgg || !metricsReady) && !loading && (nxLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11.5px] text-ink-500">
          <RefreshCw size={13} className="animate-spin text-ink-400" /> 正在检查监控组件状态…
        </div>
      ) : (nx?.installed || ms?.installed) && !(diskReadyAgg && metricsReady) ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50/70 px-3.5 py-2.5">
          <div className="flex items-start gap-2 text-[11.5px] text-ink-600">
            <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />
            <span>
              {[!diskReadyAgg && "node-exporter（磁盘）", !metricsReady && "metrics-server（CPU/内存）"].filter(Boolean).join("、")} 启动中，请稍候…
            </span>
          </div>
          <button
            onClick={loadStatus}
            disabled={monitorInstalling}
            className="shrink-0 h-8 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={monitorInstalling ? "animate-spin" : ""} /> 查看状态
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50/70 px-3.5 py-2.5">
          <div className="flex items-start gap-2 text-[11.5px] text-ink-600">
            <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />
            <span>
              未安装节点监控组件，节点磁盘使用率（根磁盘 / 与数据盘 /data）与 CPU/内存为空。一键安装 node-exporter + metrics-server。
            </span>
          </div>
          <button
            onClick={installMonitoring}
            disabled={monitorInstalling}
            className="shrink-0 h-8 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {monitorInstalling ? <><RefreshCw size={13} className="animate-spin" /> 安装中…</> : <><Plus size={13} /> 安装监控组件</>}
          </button>
        </div>
      ))}

      {monitorMsg && !monitorInstalling && (
        <div className="rounded-lg border border-line bg-sunken px-3 py-2 text-[11.5px] text-ink-500">{monitorMsg}</div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {loading ? (
          <>
            <div className="rise-1"><KpiSkeleton label="节点总数" icon={<Server size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiSkeleton label="就绪节点" icon={<ShieldCheck size={18} />} accent="ok" /></div>
            <div className="rise-3"><KpiSkeleton label="CPU 分配率" icon={<Cpu size={18} />} accent="warn" /></div>
            <div className="rise-4"><KpiSkeleton label="内存分配率" icon={<MemoryStick size={18} />} accent="cyan" /></div>
          </>
        ) : (
          <>
            <div className="rise-1"><KpiStat label="节点总数" value={total} unit="台" icon={<Server size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiStat label="就绪节点" value={ready} unit={`/ ${total}`} icon={<ShieldCheck size={18} />} accent="ok" /></div>
            <div className="rise-3"><KpiStat label="CPU 分配率" value={cpuAvg} unit="%" icon={<Cpu size={18} />} accent="warn" /></div>
            <div className="rise-4"><KpiStat label="内存分配率" value={memAvg} unit="%" icon={<MemoryStick size={18} />} accent="cyan" /></div>
          </>
        )}
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button disabled={loading} className="h-8 px-2.5 rounded-lg border border-line bg-surface text-[11.5px] text-ink-700 flex items-center gap-1.5 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
          <Filter size={12} className="text-ink-400" /> 状态：全部
        </button>
        <button disabled={loading} className="h-8 px-2.5 rounded-lg border border-line bg-surface text-[11.5px] text-ink-700 flex items-center gap-1.5 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
          <Filter size={12} className="text-ink-400" /> 角色：全部
        </button>
        <button disabled={loading} className="h-8 px-2.5 rounded-lg border border-line bg-surface text-[11.5px] text-ink-700 flex items-center gap-1.5 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
          <RefreshCw size={12} className="text-ink-400" /> 刷新
        </button>
        <div className="ml-auto flex items-center gap-2 px-3 h-9 rounded-lg bg-sunken border border-line w-64 focus-within:border-brand-300 focus-within:bg-surface transition">
          <Search size={15} className="text-ink-400" />
          <input disabled={loading} className="bg-transparent outline-none text-[12.5px] w-full placeholder:text-ink-300 disabled:cursor-not-allowed" placeholder="按节点名 / IP 筛选…" />
        </div>
      </div>

      {/* 节点表格 */}
      <Card beam={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-ink-400 text-[10.5px] font-semibold uppercase tracking-wider">
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">节点</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">角色</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">CPU</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">内存</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">磁盘</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">Pods</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">状态</th>
                <th className="text-right font-semibold px-4 py-2.5 bg-subtle border-b border-line">运行时长</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton rows={6} cols={8} />
              ) : (
                nodes.map((n) => (
                  <tr key={n.name} onClick={() => setSelected(n)} className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-sunken border border-line grid place-items-center text-brand-600">
                          <Server size={14} />
                        </div>
                        <div>
                          <div className="font-mono text-[12.5px] font-semibold text-ink-900">{n.name}</div>
                          <div className="font-mono text-[10.5px] text-ink-400">{n.ip}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-medium", (roleLabel[n.role] ?? roleLabel.worker).c)}>
                        {(roleLabel[n.role] ?? roleLabel.worker).t}
                      </span>
                    </td>
                    <td className="px-4 py-2.5"><UsageCell value={n.cpu} ready={metricsReady} /></td>
                    <td className="px-4 py-2.5"><UsageCell value={n.mem} ready={metricsReady} /></td>
                    <td className="px-4 py-2.5">
                      {n.diskReady ? (
                        <div className="flex items-center gap-1.5" title={`根磁盘 / 使用率 ${n.diskRoot ?? 0}%${n.diskData != null ? ` · 数据盘 /data ${n.diskData}%` : ""}`}>
                          <MiniGauge value={n.diskRoot ?? 0} tone={tone(n.diskRoot ?? 0)} />
                          <span className="text-[9.5px] text-ink-400 font-mono">/</span>
                        </div>
                      ) : (
                        <span className="text-[10.5px] text-ink-300 italic" title="未安装 / 未就绪 node-exporter，无法获取磁盘使用率">未就绪</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-ink-700 tabular-nums">{n.pods}/{n.podTotal}</td>
                    <td className="px-4 py-2.5"><StatusBadge kind={n.status} label={statusLabel[n.status] ?? n.status} /></td>
                    <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-400">{n.age}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 添加节点弹窗 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="添加集群节点"
        desc="通过 kubeadm 或云厂商纳管新节点"
        icon={<Server size={15} />}
        footer={
          <>
            <button onClick={() => setOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={() => setOpen(false)} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">纳管</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="节点名称"><TextInput value={form.name} onChange={set("name")} placeholder="node-gz-07" /></Field>
          <Field label="节点 IP"><TextInput value={form.ip} onChange={set("ip")} placeholder="10.0.13.25" /></Field>
          <Field label="角色"><SelectInput value={form.role} onChange={set("role")}><option>worker</option><option>control-plane</option></SelectInput></Field>
          <Field label="操作系统"><TextInput value={form.os} onChange={set("os")} placeholder="Ubuntu 22.04" /></Field>
        </div>
      </Modal>

      {/* 节点详情：展示该节点承载的所有 Pod + 资源使用率 */}
      {selected && (
        <Modal
          open={!!selected}
          onClose={() => setSelected(null)}
          maxW="max-w-xl"
          title={`节点详情 · ${selected.name}`}
          desc={`${selected.ip} · ${roleLabel[selected.role]?.t ?? selected.role} · ${selected.os}`}
          icon={<Server size={15} />}
          footer={
            <button onClick={() => setSelected(null)} className="h-9 px-3.5 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">关闭</button>
          }
        >
          <div className="space-y-4">
            {/* 节点元信息 */}
            <div className="grid grid-cols-3 gap-3 text-[11.5px]">
              <Info label="状态" value={statusLabel[selected.status] ?? selected.status} />
              <Info label="角色" value={roleLabel[selected.role]?.t ?? selected.role} />
              <Info label="运行时长" value={selected.age} />
              <Info label="Kubelet" value={selected.version} />
              <Info label="IP" value={selected.ip} />
              <Info label="Pod 数" value={`${selected.pods} / ${selected.podTotal}`} />
            </div>

            {/* 资源使用率 */}
            <div>
              <div className="text-[11px] font-semibold text-ink-500 uppercase tracking-wider mb-2">资源使用率</div>
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                <ResCell label="CPU" value={selected.cpu} ready={metricsReady} hint="未检测到 metrics-server，CPU 为降级值" />
                <ResCell label="内存" value={selected.mem} ready={metricsReady} hint="未检测到 metrics-server，内存为降级值" />
                <ResCell label="磁盘 /" value={selected.diskRoot ?? 0} ready={!!selected.diskReady} hint="未安装 node-exporter，无法获取根磁盘使用率" />
                {selected.diskReady && !selected.diskDataFound ? (
                  <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
                    <div className="text-[10.5px] text-ink-400 mb-1.5">磁盘 /data</div>
                    <span className="text-[10.5px] text-ink-300 italic" title="该节点未挂载 /data，数据盘可能挂载在其他路径">无此挂载</span>
                  </div>
                ) : (
                  <ResCell label="磁盘 /data" value={selected.diskData ?? 0} ready={!!selected.diskReady && !!selected.diskDataFound} hint="未安装 node-exporter，无法获取数据盘使用率" />
                )}
              </div>
              {(!metricsReady || !selected.diskReady) && (
                <div className="space-y-2 mt-2">
                  {!metricsReady && (
                    <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11.5px] text-ink-500">
                      <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />
                      <span>
                        未检测到 <span className="font-mono">metrics-server</span>，CPU/内存为缺数据源的降级值。安装：
                        <span className="font-mono">kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml</span>
                      </span>
                    </div>
                  )}
                  {!selected.diskReady && (
                    <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11.5px] text-ink-500">
                      <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />
                      <span>
                        未安装 <span className="font-mono">node-exporter</span>，磁盘使用率为空。点击页面上方「安装 node-exporter」即可获取根磁盘
                        <span className="font-mono"> / </span>与数据盘 <span className="font-mono">/data</span> 的真实使用率。
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 节点承载的 Pod 列表 */}
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-500 uppercase tracking-wider">
                  <Boxes size={13} /> 节点承载的 Pod（{npods.length}）
                </div>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
                  <input
                    value={npSearch}
                    onChange={(e) => setNPSearch(e.target.value)}
                    placeholder="搜索 Pod / 命名空间 / 镜像 / 工作负载"
                    className="h-8 w-64 pl-8 pr-2.5 rounded-lg border border-line bg-surface text-[12px] text-ink-800 placeholder:text-ink-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15 transition"
                  />
                </div>
              </div>
              {npLoading ? (
                <div className="overflow-x-auto rounded-lg border border-line max-h-[44vh] overflow-y-auto">
                  <table className="w-full text-[12px]">
                    <tbody><TableSkeleton rows={6} cols={7} /></tbody>
                  </table>
                </div>
              ) : npError ? (
                <ErrorBanner msg={npError} />
              ) : (
                (() => {
                  const kw = npSearch.trim().toLowerCase();
                  const filtered = kw
                    ? npods.filter((p) =>
                        [p.name, p.namespace, p.status, `${p.ownerKind}/${p.ownerName}`, p.containers[0]?.image ?? ""]
                          .join(" ").toLowerCase().includes(kw),
                      )
                    : npods;
                  if (filtered.length === 0) {
                    return (
                      <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-10 text-ink-400">
                        <Search size={18} />
                        <span className="text-[12px]">未找到匹配的 Pod</span>
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-0.5">
                      {filtered.map((p) => (
                        <div key={p.namespace + "/" + p.name} className="rounded-lg border border-line bg-surface p-3 space-y-2 hover:border-brand-200 transition">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-mono text-[12px] text-ink-900 break-all leading-snug" title={p.name}>{p.name}</span>
                            <span className="shrink-0"><StatusBadge kind={podTone(p.status)} label={p.status} /></span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                            <PodKV k="命名空间" v={p.namespace} mono />
                            <PodKV k="工作负载" v={`${p.ownerKind}/${p.ownerName}`} />
                            <PodKV k="重启" v={String(p.restarts)} mono />
                            <PodKV k="时长" v={p.age} mono />
                            <div className="col-span-2"><PodKV k="镜像" v={p.containers[0]?.image || "—"} mono truncate title={p.containers[0]?.image} /></div>
                            {p.podIP ? <div className="col-span-2"><PodKV k="Pod IP" v={p.podIP} mono /></div> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[10px] text-ink-400 mb-0.5">{label}</div>
      <div className="font-mono text-[12px] text-ink-800 truncate" title={value}>{value}</div>
    </div>
  );
}

// Pod 卡片内联键值：标签 + 值，长值可截断（带 title 悬浮查看完整内容）
function PodKV({ k, v, mono, truncate, title }: { k: string; v: string; mono?: boolean; truncate?: boolean; title?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] text-ink-400 mb-0.5">{k}</div>
      <div className={cn("text-[11px] text-ink-700", mono && "font-mono", truncate && "truncate")} title={title ?? v}>{v}</div>
    </div>
  );
}
