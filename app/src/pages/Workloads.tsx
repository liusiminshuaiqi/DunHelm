import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Card, StatusBadge, SectionTitle, Modal, Field, TextInput, SelectInput, ErrorBanner, Skeleton, TableSkeleton } from "@/components/ui/primitives";
import { type JobRow, type Workload } from "@/data/mock";
import { useWorkloads, useJobs, useClusters, useNamespaces, usePVCs } from "@/data/useLive";
import { apiGet, workloadRevisions, workloadAction, createWorkload, getWorkloadSpec, updateWorkload, getWorkloadYaml, type RevisionInfo, type EditableSpec, type ProbeParam, type LifecycleHandlerParam } from "@/lib/api";
import { getCluster } from "@/lib/cluster";
import { LogPanel } from "@/components/k8s/LogPanel";
import { ExecTerminal } from "@/components/k8s/ExecTerminal";
import { ImagePicker } from "@/components/ImagePicker";
import { cn } from "@/lib/utils";
import {
  Boxes, Search, ChevronDown, Plus, Upload, X, ScrollText, Cpu, Layers,
  RotateCw, Clock, ArrowLeft, Activity, Tag, Box, Container, Pause, Play,
  GitBranch, Hash, Server, Link2, Network, Terminal as TerminalIcon,
  AlertTriangle, CheckCircle2, FileText, ArrowUpToLine, Undo2,
  Info, Database, Trash2, Package, AlertCircle, Pencil,
} from "lucide-react";

export type WType = "deployment" | "statefulset" | "daemonset" | "job" | "cronjob";

// 进入详情子页签的导航载荷（可序列化，刷新/前进后退时通过 URL hash 还原，再据 ns+name 从列表数据 resolve 出 row）
export type DetailNav = { type: "workload" | "job"; tab: WType; namespace: string; name: string };

const labels: Record<string, string> = {
  "payment-api": "app=payment,tier=backend",
  "order-svc": "app=order,tier=backend",
  "gateway-envoy": "app=gateway,tier=edge",
  "ai-train-operator": "app=ai,tier=training",
  "user-svc": "app=user,tier=backend",
  "notify-worker": "app=notify,tier=worker",
  "grafana": "app=monitor,tier=observ",
  "elasticsearch": "app=monitor,tier=storage",
};

// 标签 / 注解 (按服务名造一份合理的元数据)
const metaByName: Record<string, { labels: [string, string][]; annotations: [string, string][]; revision?: string }> = {
  coredns: {
    labels: [["k8s-app", "kube-dns"], ["kubernetes.io/name", "CoreDNS"], ["app.kubernetes.io/name", "coredns"]],
    annotations: [
      ["deployment.kubernetes.io/revision", "2"],
      ["prometheus.io/port", "9153"],
      ["prometheus.io/scrape", "true"],
    ],
    revision: "2",
  },
};
const fallbackMeta = (name: string): { labels: [string, string][]; annotations: [string, string][]; revision: string } => ({
  labels: [["app", name], ["app.kubernetes.io/managed-by", "DunHelm"]],
  annotations: [["kubernetes.io/created-by", "DunHelm Console"]],
  revision: "1",
});

const podColor: Record<string, string> = {
  ok: "bg-ok", err: "bg-err", updating: "bg-cyan-500", pending: "bg-ink-300",
};
const statusLabel: Record<string, string> = {
  ok: "Running", updating: "Updating", err: "CrashLoop", pending: "Pending", running: "Running",
};
const podStatusBg: Record<string, string> = {
  Running: "bg-ok/10 border-ok/30 text-ok",
  Pending: "bg-warn/10 border-warn/30 text-warn",
  Succeeded: "bg-info/10 border-info/30 text-info",
  Failed: "bg-err/10 border-err/30 text-err",
  Unknown: "bg-sunken border-line text-ink-400",
  CrashLoopBackOff: "bg-err/10 border-err/30 text-err",
};

const typeLabel: Record<WType, string> = {
  deployment: "Deployment", statefulset: "StatefulSet", daemonset: "DaemonSet", job: "Job", cronjob: "CronJob",
};

const kindToK8s: Record<string, string> = {
  deployment: "Deployment", statefulset: "StatefulSet", daemonset: "DaemonSet",
};

// 后端 PodInfo DTO
interface PodInfo {
  name: string;
  status: string;
  containers: { name: string; image: string; ready: boolean }[];
  restarts: number;
  node: string;
  podIP: string;
  age: string;
  /** RFC3339 创建时间，用于判断"刚拉起" */
  createdAt: string;
  /** 所有容器均就绪 */
  ready: boolean;
  /** 正在被回收 */
  deleting: boolean;
  /** 属于当前最新版本（滚动更新后的新 Pod） */
  updated: boolean;
  podRevision: string;
}

// 滚动更新进度（后端 RolloutStatus）
interface RolloutStatus {
  desired: number;
  ready: number;
  updated: number;
  available: number;
  paused: boolean;
  progressing: boolean;
  message: string;
}

/** Pod 是否为本次操作后新拉起的（默认 90 秒内创建） */
function isFreshPod(p: PodInfo, withinSec = 90): boolean {
  if (!p.createdAt) return false;
  const t = Date.parse(p.createdAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < withinSec * 1000;
}

function dispStatus(s: string, isJob: boolean): string {
  if (isJob) return s === "running" ? "Running" : s === "ok" ? "Complete" : s === "err" ? "Failed" : s === "pending" ? "Pending" : s;
  return statusLabel[s] ?? s;
}

export function Workloads({ detailNav, onNavigate }: { detailNav: DetailNav | null; onNavigate: (d: DetailNav | null) => void }) {
  const [tab, setTab] = useState<WType>("deployment");
  const [nsFilter, setNsFilter] = useState("全部");
  const [statusFilter, setStatusFilter] = useState("全部");
  const [search, setSearch] = useState("");
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yaml, setYaml] = useState("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\n  namespace: default\n");
  const [wfOpen, setWfOpen] = useState(false);
  type PortRow = { name: string; port: string; protocol: string; hostPort: string };
  type EnvRow = { name: string; value: string };
  type ProbeRow = {
    enabled: boolean;
    type: "http" | "tcp" | "exec";
    path: string; port: string; scheme: string;
    command: string;
    initialDelay: string; period: string; timeout: string;
    failureThreshold: string; successThreshold: string;
  };
  type VolumeRow = {
    name: string;
    type: "pvc" | "emptyDir" | "hostPath" | "configMap" | "secret";
    claim: string; sizeLimit: string;
    path: string; hostPathType: string;
    refName: string;
    mountPath: string; subPath: string; readOnly: boolean;
  };
  const emptyForm = () => ({
    name: "", namespace: "default", kind: "Deployment", replicas: "1", image: "registry.local/",
    cpu: "200", mem: "512Mi", cpuReq: "", memReq: "",
    schedule: "",
    ports: [] as PortRow[], env: [] as EnvRow[],
    command: "", args: "",
    useLocalImage: true,
    livenessProbe: { enabled: false, type: "http", path: "/", port: "", scheme: "HTTP", command: "", initialDelay: "", period: "", timeout: "", failureThreshold: "", successThreshold: "" } as ProbeRow,
    readinessProbe: { enabled: false, type: "http", path: "/", port: "", scheme: "HTTP", command: "", initialDelay: "", period: "", timeout: "", failureThreshold: "", successThreshold: "" } as ProbeRow,
    startupProbe: { enabled: false, type: "http", path: "/", port: "", scheme: "HTTP", command: "", initialDelay: "", period: "", timeout: "", failureThreshold: "", successThreshold: "" } as ProbeRow,
    volumes: [] as VolumeRow[],
  });
  const [form, setForm] = useState(emptyForm);
  const set = (k: keyof ReturnType<typeof emptyForm>) => (e: { target: { value: string | boolean } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value as never }));
  const setStr = (k: keyof ReturnType<typeof emptyForm>) => (v: string) => setForm((f) => ({ ...f, [k]: v as never }));
  const setBool = (k: keyof ReturnType<typeof emptyForm>) => (v: boolean) => setForm((f) => ({ ...f, [k]: v as never }));
  const [createErr, setCreateErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [wfStep, setWfStep] = useState<"basic" | "container" | "storage">("basic");
  const [openEnv, setOpenEnv] = useState(false);
  const [openCmd, setOpenCmd] = useState(false);
  const [openProbe, setOpenProbe] = useState(false);

  // 校验某个步骤的必填项；返回错误信息（空串表示通过）。
  const validateStep = (step: "basic" | "container" | "storage"): string => {
    if (step === "basic") {
      if (!form.name.trim()) return "请填写名称（必填）";
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.name.trim()))
        return "名称格式不合法：需为小写字母/数字/连字符，且以字母或数字开头结尾";
      if (form.kind === "CronJob" && !form.schedule.trim()) return "CronJob 请填写调度周期（必填）";
      return "";
    }
    if (step === "container") {
      if (!form.image.trim()) return "请填写容器镜像（必填）";
      return "";
    }
    return "";
  };
  // 当前步骤的校验错误（实时计算，用于禁用「下一步」并提示）
  const stepErr = validateStep(wfStep);

  const doCreate = async () => {
    if (!form.name.trim() || !form.image.trim()) {
      setCreateErr("名称和镜像为必填项");
      return;
    }
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.name.trim())) {
      setCreateErr("名称格式不合法：需为小写字母/数字/连字符，且以字母或数字开头结尾");
      return;
    }
    const cid = getCluster();
    if (!cid) {
      setCreateErr("请先在顶部选择一个集群，再创建工作负载");
      return;
    }
    setCreating(true);
    setCreateErr("");
    try {
      await createWorkload({
        cluster: cid,
        kind: form.kind,
        name: form.name.trim(),
        namespace: form.namespace,
        replicas: Number(form.replicas) || 1,
        image: form.image.trim(),
        cpu: form.cpu,
        mem: form.mem,
        cpuReq: form.cpuReq,
        memReq: form.memReq,
        schedule: form.schedule,
        ports: form.ports
          .filter((p) => p.port.trim() !== "")
          .map((p) => ({
            name: p.name.trim(),
            containerPort: Number(p.port),
            protocol: p.protocol,
            hostPort: p.hostPort ? Number(p.hostPort) : 0,
          })),
        env: form.env
          .filter((e) => e.name.trim() !== "")
          .map((e) => ({ name: e.name.trim(), value: e.value })),
        command: form.command.trim() ? form.command.trim().split(/\s+/) : [],
        args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
        livenessProbe: serializeProbe(form.livenessProbe),
        readinessProbe: serializeProbe(form.readinessProbe),
        startupProbe: serializeProbe(form.startupProbe),
        volumes: form.volumes
          .filter((v) => v.name.trim() !== "" && v.mountPath.trim() !== "")
          .map((v) => ({
            name: v.name.trim(),
            type: v.type,
            claim: v.claim.trim() || undefined,
            sizeLimit: v.sizeLimit.trim() || undefined,
            path: v.path.trim() || undefined,
            hostPathType: v.hostPathType.trim() || undefined,
            refName: v.refName.trim() || undefined,
            mountPath: v.mountPath.trim(),
            subPath: v.subPath.trim() || undefined,
            readOnly: v.readOnly,
          })),
      });
      setWfOpen(false);
      setForm(emptyForm());
      setWfStep("basic");
      setOpenEnv(false); setOpenCmd(false); setOpenProbe(false);
      (workloads as any).reload?.();
    } catch (e: any) {
      setCreateErr(e?.message || "创建工作负载失败");
    } finally {
      setCreating(false);
    }
  };

  // 把向导里的探针行序列化给后端；未启用或字段不全则省略。
  const serializeProbe = (row: ProbeRow) => {
    if (!row.enabled) return undefined;
    const num = (s: string) => { const n = Number(s); return n > 0 ? n : undefined; };
    const p: any = { type: row.type };
    if (row.type === "http") {
      p.path = row.path || "/";
      p.port = Number(row.port) || undefined;
      p.scheme = row.scheme || "HTTP";
    } else if (row.type === "tcp") {
      p.port = Number(row.port) || undefined;
    } else {
      p.command = row.command.trim() ? row.command.trim().split(/\s+/) : undefined;
    }
    p.initialDelaySeconds = num(row.initialDelay);
    p.periodSeconds = num(row.period);
    p.timeoutSeconds = num(row.timeout);
    p.failureThreshold = num(row.failureThreshold);
    p.successThreshold = num(row.successThreshold);
    if (row.type !== "exec" && !p.port) return undefined;
    if (row.type === "exec" && !p.command) return undefined;
    return p;
  };

  const workloads = useWorkloads();
  const jobData = useJobs("job");
  const cronData = useJobs("cronjob");
  const nsList = useNamespaces();
  const livePvcs = usePVCs() as any;

  // 当前命名空间下可选的 PVC（供存储设置挂载）
  const nsPvcs = Array.isArray(livePvcs) ? livePvcs.filter((p: any) => p.namespace === form.namespace) : [];

  const isJobTab = tab === "job" || tab === "cronjob";
  const wlLoading = (workloads as any)._loading === true;
  const jobLoading = (jobData as any)._loading === true;
  const cronLoading = (cronData as any)._loading === true;
  const loading = isJobTab ? (tab === "job" ? jobLoading : cronLoading) : wlLoading;
  const allItems: (Workload | JobRow)[] = isJobTab
    ? (tab === "job" ? jobData : cronData)
    : (workloads as Workload[]).filter((w) => w.kind === tab);

  const nsOptions = useMemo(() => Array.from(new Set(allItems.map((r) => r.namespace))).sort(), [allItems]);
  const statusOptions = useMemo(() => Array.from(new Set(allItems.map((r) => dispStatus(r.status, isJobTab)))), [allItems, isJobTab]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allItems.filter((r) => {
      if (nsFilter !== "全部" && r.namespace !== nsFilter) return false;
      if (statusFilter !== "全部" && dispStatus(r.status, isJobTab) !== statusFilter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allItems, nsFilter, statusFilter, search, isJobTab]);

  const podCounts = (["deployment", "statefulset", "daemonset"] as WType[]).map((k) => ({
    k, n: wlLoading ? 0 : (workloads as Workload[]).filter((w) => w.kind === k).length,
  }));
  const jobCount = jobLoading ? 0 : jobData.length;
  const cronCount = cronLoading ? 0 : cronData.length;
  const counts: { k: WType; n: number }[] = [...podCounts, { k: "job", n: jobCount }, { k: "cronjob", n: cronCount }];
  const colCount = tab === "job" ? 7 : 8;

  const wLen = (workloads as Workload[]).length;
  const hasError = (workloads as any)._error || (jobData as any)._error || (cronData as any)._error;

  // —— 刷新 / 前进后退后还原详情：detailNav 仅含可序列化的 (type,tab,ns,name)，
  //    需等列表数据加载完成后据 ns+name 从 workloads/jobData/cronData 还原出 row ——
  const detailLoading = !detailNav
    ? false
    : detailNav.type === "job"
      ? (detailNav.tab === "cronjob" ? cronLoading : jobLoading)
      : wlLoading;
  const resolvedRow = !detailNav
    ? null
    : detailNav.type === "job"
      ? (detailNav.tab === "cronjob" ? cronData : jobData).find(
          (r) => r.namespace === detailNav.namespace && r.name === detailNav.name,
        ) ?? null
      : (workloads as Workload[]).find(
          (r) => r.namespace === detailNav.namespace && r.name === detailNav.name,
        ) ?? null;

  // 进入详情时让列表 tab 与详情 tab 对齐，返回列表时停留在正确分类
  useEffect(() => {
    if (detailNav) setTab(detailNav.tab);
  }, [detailNav]);

  // 数据已加载但找不到该资源（已删除 / 集群切换）：自动回退列表，避免死胡同
  useEffect(() => {
    if (detailNav && !detailLoading && !resolvedRow) onNavigate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailNav, detailLoading, resolvedRow]);

  return (
    <div className="top-aura relative p-5 space-y-4">
      {hasError ? <ErrorBanner msg={hasError} /> : null}
      {((workloads as any)._permDenied || (jobData as any)._permDenied || (cronData as any)._permDenied) && (
        <ErrorBanner msg="当前账号无该集群的访问权限，暂无数据展示" title="无集群访问权限" hint="当前账号未被授权访问该集群，已清空展示数据。" />
      )}

      {!detailNav ? (
        <>
          <SectionTitle
            title="工作负载"
            desc={loading ? "正在从集群加载工作负载…" : `共 ${wLen + jobCount + cronCount} 个工作负载 · 跨 ${new Set((workloads as Workload[]).map((w) => w.namespace)).size} 个命名空间`}
            right={
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setYamlOpen(true)}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] font-medium text-ink-700 hover:border-brand-300 hover:text-brand-700 transition"
                >
                  <Upload size={15} /> 导入 YAML
                </button>
                <button onClick={() => setWfOpen(true)} className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">
                  <Plus size={15} /> 创建工作负载
                </button>
              </div>
            }
          />

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex p-0.5 bg-sunken rounded-lg border border-line">
              {counts.map(({ k, n }) => (
                <button
                  key={k}
                  onClick={() => { setTab(k); setNsFilter("全部"); setStatusFilter("全部"); }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-medium transition",
                    tab === k ? "bg-surface text-brand-700 shadow-sh-1" : "text-ink-500 hover:text-ink-900",
                  )}
                >
                  {typeLabel[k]}
                  {loading ? (
                    <Skeleton className="inline-block h-3 w-3 rounded" />
                  ) : (
                    <span className={cn("font-mono text-[10px] px-1 rounded", tab === k ? "bg-brand-50 text-brand-600" : "bg-line text-ink-400")}>{n}</span>
                  )}
                </button>
              ))}
            </div>
            <FilterSelect label="命名空间" value={nsFilter} options={nsOptions} onChange={setNsFilter} />
            <FilterSelect label="状态" value={statusFilter} options={statusOptions} onChange={setStatusFilter} />
            <div className="ml-auto flex items-center gap-2 px-3 h-9 rounded-lg bg-sunken border border-line w-64 focus-within:border-brand-300 focus-within:bg-surface transition">
              <Search size={15} className="text-ink-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-transparent outline-none text-[12.5px] w-full placeholder:text-ink-300"
                placeholder="按名称 / 标签筛选…"
              />
            </div>
          </div>

          <Card beam={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-ink-400 text-[10.5px] font-semibold uppercase tracking-wider">
                    <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">名称</th>
                    <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">状态</th>
                    <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">命名空间</th>
                    {tab === "job" && <><th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">完成 / 并行</th><th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">耗时</th></>}
                    {tab === "cronjob" && <><th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">调度计划</th><th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">活跃</th></>}
                    {tab !== "job" && tab !== "cronjob" && (
                      <>
                        <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">副本</th>
                        <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">容器组</th>
                      </>
                    )}
                    <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">镜像</th>
                    {tab === "cronjob" && <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">上次 / 下次</th>}
                    {tab !== "job" && tab !== "cronjob" && <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">CPU / 内存</th>}
                    <th className="text-right font-semibold px-4 py-2.5 bg-subtle border-b border-line">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <TableSkeleton rows={7} cols={colCount} />
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center text-[12.5px] text-ink-400">
                        没有符合条件的工作负载{nsFilter !== "全部" || statusFilter !== "全部" || search ? "（试试调整筛选条件）" : ""}
                      </td>
                    </tr>
                  ) : (
                    <>
                      {!isJobTab &&
                        filtered.map((w) => {
                          const wl = w as Workload;
                          return (
                            <tr
                              key={wl.name}
                              onClick={() => onNavigate({ type: "workload", tab, namespace: wl.namespace, name: wl.name })}
                              className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer"
                            >
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-7 h-7 rounded-lg bg-brand-50 border border-brand-100 grid place-items-center text-brand-600">
                                    <Boxes size={14} />
                                  </div>
                                  <div>
                                    <div className="font-mono text-[12.5px] font-semibold text-ink-900">{wl.name}</div>
                                    <div className="font-mono text-[10.5px] text-ink-400">{labels[wl.name] ?? wl.namespace}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-2.5"><StatusBadge kind={wl.status} label={statusLabel[wl.status]} /></td>
                              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500">{wl.namespace}</td>
                              <td className="px-4 py-2.5 font-mono text-ink-700 tabular-nums">{wl.ready}/{wl.desired}</td>
                              <td className="px-4 py-2.5"><PodBars pods={wl.pods} /></td>
                              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500 truncate max-w-[180px]">{wl.image}</td>
                              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500 tabular-nums">{wl.cpu}m / {(wl.cpu / 500).toFixed(1)}Gi</td>
                              <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-400">{wl.age}</td>
                            </tr>
                          );
                        })}
                      {isJobTab &&
                        filtered.map((j) => {
                          const jr = j as JobRow;
                          return (
                            <tr
                              key={jr.name}
                              onClick={() => onNavigate({ type: "job", tab, namespace: jr.namespace, name: jr.name })}
                              className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer"
                            >
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-7 h-7 rounded-lg bg-cyan-100 border border-cyan-200 grid place-items-center text-cyan-600">
                                    <Boxes size={14} />
                                  </div>
                                  <div>
                                    <div className="font-mono text-[12.5px] font-semibold text-ink-900">{jr.name}</div>
                                    <div className="font-mono text-[10.5px] text-ink-400">{jr.namespace}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-2.5"><StatusBadge kind={jr.status} label={jr.status === "running" ? "Running" : jr.status === "ok" ? "Complete" : "Failed"} /></td>
                              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500">{jr.namespace}</td>
                              {tab === "job" ? (
                                <>
                                  <td className="px-4 py-2.5 font-mono text-ink-700 tabular-nums">{jr.completions}/{jr.parallelism}</td>
                                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500">{jr.duration}</td>
                                </>
                              ) : (
                                <>
                                  <td className="px-4 py-2.5 font-mono text-[11.5px] text-ink-700">{jr.schedule}</td>
                                  <td className="px-4 py-2.5">
                                    <span className={cn("font-mono text-[11.5px] px-1.5 py-0.5 rounded", (jr.active ?? 0) > 0 ? "bg-cyan-100 text-cyan-600" : "bg-sunken text-ink-400")}>{(jr.active ?? 0)}</span>
                                  </td>
                                </>
                              )}
                              <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500 truncate max-w-[180px]">{jr.image}</td>
                              {tab === "cronjob" && (
                                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500">{jr.lastSchedule} / {jr.nextSchedule}</td>
                              )}
                              <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-400">{jr.age}                  </td>
                            </tr>
                          );
                        })}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {yamlOpen && createPortal(
            <div className="fixed inset-0 z-[100] grid place-items-center bg-ink-900/30 backdrop-blur-sm p-4" onClick={() => setYamlOpen(false)}>
              <div className="w-full max-w-2xl rounded-xl border border-line bg-surface shadow-sh-3 overflow-hidden card-beam" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-subtle">
                  <Upload size={15} className="text-brand-600" />
                  <h3 className="text-[13.5px] font-semibold text-ink-900">导入 YAML 创建资源</h3>
                  <button onClick={() => setYamlOpen(false)} className="ml-auto w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-sunken transition"><X size={15} /></button>
                </div>
                <div className="p-4">
                  <textarea
                    value={yaml}
                    onChange={(e) => setYaml(e.target.value)}
                    spellCheck={false}
                    className="w-full h-64 font-mono text-[12px] text-ink-800 bg-sunken border border-line rounded-lg p-3 outline-none focus:border-brand-300 resize-none leading-relaxed"
                  />
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-ink-400">支持 Deployment / StatefulSet / Job / CronJob 等资源定义</span>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setYamlOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
                      <button onClick={() => setYamlOpen(false)} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">应用</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )}

          <Modal
            open={wfOpen}
            onClose={() => { setWfOpen(false); setWfStep("basic"); setCreateErr(""); }}
            title="创建工作负载"
            desc="Deployment / StatefulSet / DaemonSet / Job / CronJob"
            icon={<Plus size={15} />}
            maxW="max-w-3xl"
            footer={null}
          >
            {/* 顶部步骤指示条（KubeSphere 风格：图标 + 当前步高亮） */}
            <div className="-mx-4 -mt-4 px-4 py-3 border-b border-line bg-subtle">
              <div className="flex items-center gap-1">
                {([
                  { id: "basic", label: "基本信息", icon: Info },
                  { id: "container", label: "容器组设置", icon: Box },
                  { id: "storage", label: "存储设置", icon: Database },
                ] as const).map((s, i, arr) => {
                  const Active = wfStep === s.id;
                  const Done = arr.findIndex((x) => x.id === wfStep) > i;
                  const Icon = s.icon;
                  return (
                    <div key={s.id} className="flex items-center flex-1">
                      <button
                        onClick={() => {
                          // 不允许跳到比当前更靠后的步骤（当前步必填项未过则不能前进）
                          const curIdx = arr.findIndex((x) => x.id === wfStep);
                          if (i > curIdx && validateStep(wfStep) !== "") {
                            setCreateErr(validateStep(wfStep));
                            return;
                          }
                          setCreateErr("");
                          setWfStep(s.id);
                        }}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium transition",
                          Active ? "bg-brand-50 text-brand-700 border border-brand-200" :
                            Done ? "text-ink-500 hover:bg-sunken" : "text-ink-400 hover:bg-sunken"
                        )}
                      >
                        <span className={cn(
                          "w-5 h-5 grid place-items-center rounded-full text-[10px] font-semibold",
                          Active ? "bg-brand-600 text-white" :
                            Done ? "bg-ok text-white" : "bg-line text-ink-500"
                        )}>{i + 1}</span>
                        <Icon size={13} className={Active ? "text-brand-600" : Done ? "text-ok" : "text-ink-400"} />
                        {s.label}
                      </button>
                      {i < arr.length - 1 && <div className={cn("flex-1 h-px mx-2", Done ? "bg-ok" : "bg-line")} />}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 步骤 1：基本信息 */}
            {wfStep === "basic" && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <Field
                  label={"名称 *"}
                  hint={form.name.trim() !== "" && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.name.trim()) ? "需为小写字母/数字/连字符，且以字母或数字开头结尾" : "创建后不可修改，将作为资源名与 selector（必填）"}
                >
                  <TextInput
                    value={form.name}
                    onChange={set("name")}
                    placeholder="my-app"
                    className={form.name.trim() !== "" && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.name.trim()) ? "border-err focus:border-err" : ""}
                  />
                </Field>
                <Field label="命名空间"><SelectInput value={form.namespace} onChange={set("namespace")}>{nsList.map((n) => <option key={n} value={n}>{n}</option>)}</SelectInput></Field>
                <Field label="类型"><SelectInput value={form.kind} onChange={set("kind")}>
                  <option>Deployment</option><option>StatefulSet</option><option>DaemonSet</option><option>Job</option><option>CronJob</option>
                </SelectInput></Field>
                {form.kind !== "DaemonSet" && form.kind !== "Job" && form.kind !== "CronJob" && (
                  <Field label="副本数"><TextInput type="number" min={1} value={form.replicas} onChange={set("replicas")} /></Field>
                )}
                {form.kind === "CronJob" && (
                  <Field label="调度周期" className="col-span-2" hint="标准 cron 表达式（5 字段）">
                    <TextInput value={form.schedule} onChange={set("schedule")} placeholder="*/5 * * * *" />
                  </Field>
                )}
              </div>
            )}

            {/* 步骤 2：容器组设置（参考 KubeSphere） */}
            {wfStep === "container" && (
              <div className="space-y-4 pt-1">
                {/* 镜像（保留 ImagePicker：可手填也可点右侧从 Harbor 选） */}
                <div className="rounded-lg border border-line bg-surface p-3.5">
                  <div className="flex items-center gap-1.5 mb-2.5">
                    <Package size={13} className="text-brand-600" />
                    <span className="text-[12.5px] font-semibold text-ink-800">镜像</span>
                    <span className="text-[10.5px] text-ink-400 ml-1">支持手填或从镜像仓库选择</span>
                  </div>
                  <ImagePicker value={form.image} onChange={setStr("image")} placeholder="registry.local/namespace/image:tag（也可点右侧「选择」从镜像仓库选）" />
                  <label className="mt-2 flex items-center gap-1.5 text-[11.5px] text-ink-500 cursor-pointer">
                    <input type="checkbox" checked={form.useLocalImage} onChange={(e) => setBool("useLocalImage")(e.target.checked)} className="rounded border-line text-brand-600 focus:ring-brand-200" />
                    优先使用本地镜像（如 node 上已有同名 tag 则直接用）
                  </label>
                </div>

                {/* 资源（CPU 预留/限制 + 内存 预留/限制） */}
                <div className="rounded-lg border border-line bg-surface p-3.5">
                  <div className="flex items-center gap-1.5 mb-2.5">
                    <Cpu size={13} className="text-brand-600" />
                    <span className="text-[12.5px] font-semibold text-ink-800">资源限制</span>
                    <span className="text-[10.5px] text-ink-400 ml-1">CPU 毫核，内存 K8s Quantity（Mi/Gi）</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2.5">
                    <Field label="CPU 预留" hint="request"><TextInput value={form.cpuReq} onChange={set("cpuReq")} placeholder="100" /></Field>
                    <Field label="CPU 限制" hint="limit"><TextInput value={form.cpu} onChange={set("cpu")} placeholder="200" /></Field>
                    <Field label="内存预留" hint="request"><TextInput value={form.memReq} onChange={set("memReq")} placeholder="256Mi" /></Field>
                    <Field label="内存限制" hint="limit"><TextInput value={form.mem} onChange={set("mem")} placeholder="512Mi" /></Field>
                  </div>
                </div>

                {/* 端口设置 */}
                <div className="rounded-lg border border-line bg-surface p-3.5">
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-1.5">
                      <Network size={13} className="text-brand-600" />
                      <span className="text-[12.5px] font-semibold text-ink-800">端口设置</span>
                      <span className="text-[10.5px] text-ink-400 ml-1">设置用于访问容器的端口</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, ports: [...f.ports, { name: "", port: "", protocol: "TCP", hostPort: "" }] }))}
                      className="h-7 px-2.5 rounded-md border border-line text-[11.5px] text-ink-700 hover:bg-sunken inline-flex items-center gap-1"
                    >
                      <Plus size={11} /> 添加端口
                    </button>
                  </div>
                  {form.ports.length === 0 && (
                    <div className="text-[11.5px] text-ink-400 py-2 text-center">尚未配置端口</div>
                  )}
                  <div className="space-y-2">
                    {form.ports.map((p, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <select
                          value={p.protocol}
                          onChange={(e) => setForm((f) => ({ ...f, ports: f.ports.map((x, j) => j === i ? { ...x, protocol: e.target.value } : x) }))}
                          className="h-8 px-2 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300"
                        >
                          <option>TCP</option><option>UDP</option><option>SCTP</option>
                        </select>
                        <input
                          value={p.name}
                          onChange={(e) => setForm((f) => ({ ...f, ports: f.ports.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))}
                          placeholder="名称（http-0）"
                          className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300"
                        />
                        <input
                          value={p.port}
                          onChange={(e) => setForm((f) => ({ ...f, ports: f.ports.map((x, j) => j === i ? { ...x, port: e.target.value } : x) }))}
                          placeholder="容器端口"
                          className="h-8 px-2.5 w-24 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, ports: f.ports.filter((_, j) => j !== i) }))}
                          className="w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-err-bg hover:text-err transition"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 环境变量（折叠） */}
                <FoldCard
                  open={openEnv}
                  onToggle={() => setOpenEnv((o) => !o)}
                  icon={<Tag size={13} className="text-brand-600" />}
                  title="环境变量"
                  hint="为容器添加添加环境变量"
                >
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, env: [...f.env, { name: "", value: "" }] }))}
                      className="h-7 px-2.5 rounded-md border border-line text-[11.5px] text-ink-700 hover:bg-sunken inline-flex items-center gap-1"
                    >
                      <Plus size={11} /> 添加环境变量
                    </button>
                    {form.env.map((e, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <input
                          value={e.name}
                          onChange={(ev) => setForm((f) => ({ ...f, env: f.env.map((x, j) => j === i ? { ...x, name: ev.target.value } : x) }))}
                          placeholder="变量名（如 NODE_ENV）"
                          className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300"
                        />
                        <span className="text-ink-300">=</span>
                        <input
                          value={e.value}
                          onChange={(ev) => setForm((f) => ({ ...f, env: f.env.map((x, j) => j === i ? { ...x, value: ev.target.value } : x) }))}
                          placeholder="值"
                          className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300"
                        />
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, env: f.env.filter((_, j) => j !== i) }))}
                          className="w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-err-bg hover:text-err transition"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </FoldCard>

                {/* 启动命令（折叠） */}
                <FoldCard
                  open={openCmd}
                  onToggle={() => setOpenCmd((o) => !o)}
                  icon={<TerminalIcon size={13} className="text-brand-600" />}
                  title="启动命令"
                  hint="自定义容器启动时运行的命令 / 参数（覆盖镜像默认入口）"
                >
                  <div className="grid grid-cols-1 gap-2">
                    <Field label="执行命令（command）" hint="空格分隔多个 token，例如 /bin/sh -c">
                      <TextInput value={form.command} onChange={set("command")} placeholder="/bin/sh -c" className="font-mono" />
                    </Field>
                    <Field label="参数（args）" hint="空格分隔多个 token">
                      <TextInput value={form.args} onChange={set("args")} placeholder="node server.js --port 8080" className="font-mono" />
                    </Field>
                  </div>
                </FoldCard>

                {/* 健康检查（折叠；存活 / 就绪 / 启动 三种探针，每种可独立启用） */}
                <FoldCard
                  open={openProbe}
                  onToggle={() => setOpenProbe((o) => !o)}
                  icon={<Activity size={13} className="text-brand-600" />}
                  title="健康检查"
                  hint="配置探针定时检查容器健康（存活/就绪/启动，支持 HTTP / TCP / Exec）"
                >
                  <div className="space-y-4">
                    {([
                      { key: "livenessProbe", label: "存活探针", desc: "探测失败会重启容器" },
                      { key: "readinessProbe", label: "就绪探针", desc: "探测失败会摘除流量（不从 Service 转发）" },
                      { key: "startupProbe", label: "启动探针", desc: "启动期间探测成功前不执行其他探针" },
                    ] as const).map((pr) => {
                      const row = (form as any)[pr.key] as ProbeRow;
                      const setRow = (patch: Partial<ProbeRow>) =>
                        setForm((f) => ({ ...f, [pr.key]: { ...(f as any)[pr.key], ...patch } }));
                      return (
                        <div key={pr.key} className="rounded-lg border border-line bg-surface p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-semibold text-ink-800">{pr.label}</span>
                              <span className="text-[10.5px] text-ink-400">{pr.desc}</span>
                            </div>
                            <label className="flex items-center gap-1.5 text-[11px] text-ink-600 cursor-pointer">
                              <input type="checkbox" checked={row.enabled} onChange={(e) => setRow({ enabled: e.target.checked })} className="rounded border-line text-brand-600 focus:ring-brand-200" />
                              启用
                            </label>
                          </div>
                          {row.enabled && (
                            <div className="space-y-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] text-ink-500 w-14">类型</span>
                                <SelectInput value={row.type} onChange={(e) => setRow({ type: e.target.value as ProbeRow["type"] })}>
                                  <option value="http">HTTP 请求</option>
                                  <option value="tcp">TCP 端口</option>
                                  <option value="exec">执行命令</option>
                                </SelectInput>
                              </div>
                              {row.type === "http" && (
                                <div className="grid grid-cols-3 gap-2">
                                  <Field label="路径"><TextInput value={row.path} onChange={(e) => setRow({ path: e.target.value })} placeholder="/healthz" /></Field>
                                  <Field label="端口"><TextInput value={row.port} onChange={(e) => setRow({ port: e.target.value })} placeholder="8080" /></Field>
                                  <Field label="协议"><SelectInput value={row.scheme} onChange={(e) => setRow({ scheme: e.target.value })}><option>HTTP</option><option>HTTPS</option></SelectInput></Field>
                                </div>
                              )}
                              {row.type === "tcp" && (
                                <Field label="端口"><TextInput value={row.port} onChange={(e) => setRow({ port: e.target.value })} placeholder="8080" /></Field>
                              )}
                              {row.type === "exec" && (
                                <Field label="命令" hint="空格分隔多个参数，如 /bin/sh -c"><TextInput value={row.command} onChange={(e) => setRow({ command: e.target.value })} placeholder="cat /tmp/healthy" className="font-mono" /></Field>
                              )}
                              <div className="grid grid-cols-5 gap-2">
                                <Field label="延迟(s)"><TextInput value={row.initialDelay} onChange={(e) => setRow({ initialDelay: e.target.value })} placeholder="10" /></Field>
                                <Field label="间隔(s)"><TextInput value={row.period} onChange={(e) => setRow({ period: e.target.value })} placeholder="10" /></Field>
                                <Field label="超时(s)"><TextInput value={row.timeout} onChange={(e) => setRow({ timeout: e.target.value })} placeholder="1" /></Field>
                                <Field label="失败阈值"><TextInput value={row.failureThreshold} onChange={(e) => setRow({ failureThreshold: e.target.value })} placeholder="3" /></Field>
                                <Field label="成功阈值"><TextInput value={row.successThreshold} onChange={(e) => setRow({ successThreshold: e.target.value })} placeholder="1" /></Field>
                              </div>
                              <div className="text-[10px] text-ink-400">阈值留空则使用 Kubernetes 默认值</div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </FoldCard>
              </div>
            )}

            {/* 步骤 3：存储设置（数据卷：PVC / emptyDir / hostPath / configMap / secret 挂载） */}
            {wfStep === "storage" && (
              <div className="space-y-3 pt-1">
                <div className="rounded-lg border border-line bg-surface p-3.5">
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-1.5">
                      <Database size={13} className="text-brand-600" />
                      <span className="text-[12.5px] font-semibold text-ink-800">数据卷</span>
                      <span className="text-[10.5px] text-ink-400 ml-1">为容器挂载存储卷</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, volumes: [...f.volumes, { name: "", type: "pvc", claim: "", sizeLimit: "", path: "", hostPathType: "DirectoryOrCreate", refName: "", mountPath: "", subPath: "", readOnly: false }] }))}
                      className="h-7 px-2.5 rounded-md border border-line text-[11.5px] text-ink-700 hover:bg-sunken inline-flex items-center gap-1"
                    >
                      <Plus size={11} /> 添加数据卷
                    </button>
                  </div>

                  {form.volumes.length === 0 && (
                    <div className="text-[11.5px] text-ink-400 py-2 text-center">尚未配置存储卷</div>
                  )}

                  <div className="space-y-2.5">
                    {form.volumes.map((v, i) => {
                      const setV = (patch: Partial<VolumeRow>) =>
                        setForm((f) => ({ ...f, volumes: f.volumes.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
                      return (
                        <div key={i} className="rounded-lg border border-line bg-subtle p-3 space-y-2.5">
                          <div className="flex items-center gap-1.5">
                            <input
                              value={v.name}
                              onChange={(e) => setV({ name: e.target.value })}
                              placeholder="卷名称（如 data）"
                              className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300"
                            />
                            <select
                              value={v.type}
                              onChange={(e) => setV({ type: e.target.value as VolumeRow["type"] })}
                              className="h-8 px-2 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300"
                            >
                              <option value="pvc">PVC（持久卷）</option>
                              <option value="emptyDir">emptyDir（临时卷）</option>
                              <option value="hostPath">hostPath（节点路径）</option>
                              <option value="configMap">ConfigMap</option>
                              <option value="secret">Secret</option>
                            </select>
                            <button
                              type="button"
                              onClick={() => setForm((f) => ({ ...f, volumes: f.volumes.filter((_, j) => j !== i) }))}
                              className="w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-err-bg hover:text-err transition"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>

                          {v.type === "pvc" && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] text-ink-500 w-16">PVC 名称</span>
                              <input
                                list="wl-pvc-list"
                                value={v.claim}
                                onChange={(e) => setV({ claim: e.target.value })}
                                placeholder={nsPvcs.length ? "选择或输入 PVC" : "需先创建 PVC"}
                                className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300"
                              />
                              <datalist id="wl-pvc-list">
                                {nsPvcs.map((p: any) => <option key={p.name} value={p.name} />)}
                              </datalist>
                            </div>
                          )}
                          {v.type === "emptyDir" && (
                            <Field label="容量上限（可选）" hint="如 1Gi，空白表示节点磁盘不限"><TextInput value={v.sizeLimit} onChange={(e) => setV({ sizeLimit: e.target.value })} placeholder="1Gi" /></Field>
                          )}
                          {v.type === "hostPath" && (
                            <div className="grid grid-cols-2 gap-2">
                              <Field label="节点路径"><TextInput value={v.path} onChange={(e) => setV({ path: e.target.value })} placeholder="/data" /></Field>
                              <Field label="类型"><SelectInput value={v.hostPathType} onChange={(e) => setV({ hostPathType: e.target.value })}><option>DirectoryOrCreate</option><option>Directory</option><option>FileOrCreate</option><option>File</option><option>Socket</option><option>CharDevice</option><option>BlockDevice</option></SelectInput></Field>
                            </div>
                          )}
                          {(v.type === "configMap" || v.type === "secret") && (
                            <Field label={v.type === "configMap" ? "ConfigMap 名称" : "Secret 名称"}>
                              <TextInput value={v.refName} onChange={(e) => setV({ refName: e.target.value })} placeholder="my-config" className="font-mono" />
                            </Field>
                          )}

                          <div className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
                            <span className="text-[11px] text-ink-500">挂载路径</span>
                            <input
                              value={v.mountPath}
                              onChange={(e) => setV({ mountPath: e.target.value })}
                              placeholder="/data（容器内的挂载目录）"
                              className="h-8 px-2.5 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300"
                            />
                            <label className="flex items-center gap-1.5 text-[11px] text-ink-600 cursor-pointer whitespace-nowrap">
                              <input type="checkbox" checked={v.readOnly} onChange={(e) => setV({ readOnly: e.target.checked })} className="rounded border-line text-brand-600 focus:ring-brand-200" />
                              只读
                            </label>
                          </div>
                          <Field label="子路径（可选）" hint="挂载卷内子目录，如 logs"><TextInput value={v.subPath} onChange={(e) => setV({ subPath: e.target.value })} placeholder="sub/path" className="font-mono" /></Field>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {createErr && (
              <div className="mt-3 rounded-lg border border-err bg-err-bg/30 px-3 py-2 text-[12px] text-err">
                {createErr}
              </div>
            )}

            {/* 底部：上一步 / 下一步 / 创建（参考 KubeSphere 三按钮布局） */}
            <div className="mt-4 pt-3 border-t border-line">
              {/* 当前步骤必填校验提示 */}
              {stepErr && (
                <div className="mb-2.5 text-[11.5px] text-err flex items-center gap-1.5">
                  <AlertCircle size={13} /> {stepErr}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { setWfOpen(false); setWfStep("basic"); setCreateErr(""); }}
                className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition"
              >取消</button>
              {wfStep !== "basic" && (
                <button
                  onClick={() => setWfStep(wfStep === "storage" ? "container" : "basic")}
                  className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition"
                >上一步</button>
              )}
              {wfStep !== "storage" ? (
                <button
                  onClick={() => { if (stepErr) { setCreateErr(stepErr); return; } setWfStep(wfStep === "basic" ? "container" : "storage"); }}
                  disabled={stepErr !== ""}
                  className={cn(
                    "h-9 px-3.5 rounded-lg text-[12.5px] font-medium transition",
                    stepErr !== ""
                      ? "bg-sunken text-ink-400 cursor-not-allowed"
                      : "bg-gradient-to-r from-brand-600 to-cyan-500 text-white shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95"
                  )}
                >下一步</button>
              ) : (
                <button
                  onClick={doCreate}
                  disabled={creating}
                  className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {creating ? "创建中…" : "创建"}
                </button>
              )}
              </div>
            </div>
          </Modal>
        </>
      ) : resolvedRow ? (
        <WorkloadDetailPage
          type={detailNav.type}
          row={resolvedRow}
          tab={detailNav.tab}
          onClose={() => onNavigate(null)}
          reload={workloads.reload}
        />
      ) : detailLoading ? (
        <DetailLoading name={detailNav.name} />
      ) : (
        <DetailNotFound name={detailNav.name} onClose={() => onNavigate(null)} />
      )}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none h-8 pl-2.5 pr-7 rounded-lg border border-line bg-surface text-[11.5px] text-ink-700 hover:border-brand-300 transition cursor-pointer outline-none focus:border-brand-300"
      >
        <option value="全部">{label}：全部</option>
        {options.filter((o) => o && o !== "全部").map((o) => (
          <option key={o} value={o}>{label}：{o}</option>
        ))}
      </select>
      <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
    </div>
  );
}

// 刷新 / 前进后退后，列表数据尚未就绪时的详情占位
function DetailLoading({ name }: { name: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line bg-surface text-ink-700"><ArrowLeft size={15} /> 返回</span>
        <span className="text-ink-300">/</span>
        <span className="text-ink-500">工作负载</span>
        <span className="text-ink-300">/</span>
        <span className="font-mono text-ink-900 font-semibold">{name}</span>
      </div>
      <Card beam={false}>
        <div className="p-10 grid place-items-center text-[12.5px] text-ink-400">正在从集群加载工作负载详情…</div>
      </Card>
    </div>
  );
}

// 资源在当前集群已不存在（已删除 / 集群切换）时的兜底
function DetailNotFound({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-[12px]">
        <button onClick={onClose} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line bg-surface text-ink-700 hover:border-brand-300 hover:text-brand-700 transition"><ArrowLeft size={15} /> 返回</button>
        <span className="text-ink-300">/</span>
        <span className="text-ink-500">工作负载</span>
        <span className="text-ink-300">/</span>
        <span className="font-mono text-ink-900 font-semibold">{name}</span>
      </div>
      <Card beam={false}>
        <div className="p-10 grid place-items-center text-[12.5px] text-ink-500">
          未在当前集群找到 <span className="font-mono text-ink-700 mx-1">{name}</span>，可能已被删除或集群已切换。
        </div>
      </Card>
    </div>
  );
}

// 详情子页签（替代原右侧抽屉，全屏铺满主区域）
function WorkloadDetailPage({ type, row, tab, onClose, reload }: { type: "workload" | "job"; row: Workload | JobRow; tab: WType; onClose: () => void; reload?: () => void }) {
  const isJob = type === "job";
  const wl = row as Workload;
  const jr = row as JobRow;
  const status = dispStatus(row.status, isJob);
  const kindK8s = isJob ? (tab === "cronjob" ? "CronJob" : "Job") : kindToK8s[(wl as any).kind] ?? "Deployment";

  const [sub, setSub] = useState<"overview" | "pods" | "yaml" | "events">("overview");
  const yaml = buildYaml(row, type, kindK8s, tab);

  const cluster = getCluster() ?? "";
  const { data: clusters } = useClusters();
  // 当前选中集群的真实健康状态：决定能否执行写操作
  const currentCluster = useMemo(
    () => clusters.find((c) => String(c.id) === String(cluster)),
    [clusters, cluster],
  );
  const clusterReady = currentCluster?.health === "ready";
  const clusterName = currentCluster?.name || cluster;
  const [pods, setPods] = useState<PodInfo[]>([]);
  const [rollout, setRollout] = useState<RolloutStatus | null>(null);
  const [podsLoading, setPodsLoading] = useState(true);
  const [podsError, setPodsError] = useState("");
  const [active, setActive] = useState<{ pod: string; container: string; mode: "logs" | "exec" } | null>(null);
  // 写操作后进入"紧盯"窗口：这段时间内强制高频轮询，确保能看到滚动更新过程
  const watchUntilRef = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // 写操作相关状态（暂停/重启/升级/回滚）
  // pausedFromRev 来自发布历史接口（进入页面/操作后刷新），rollout.paused 来自实时轮询；
  // 以实时轮询为准，避免按钮文案滞后于集群真实状态。
  const [pausedFromRev, setPaused] = useState(false);
  const [revisions, setRevisions] = useState<RevisionInfo[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [upgradeImages, setUpgradeImages] = useState<Record<string, string>>({});
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [confirmState, setConfirmState] = useState<{ title: string; body: string; onConfirm: () => void } | null>(null);

  // 实时 YAML 清单（替代原先不完整的手动拼装）
  const [liveYaml, setLiveYaml] = useState("");
  const [yamlLoading, setYamlLoading] = useState(false);
  const [yamlError, setYamlError] = useState("");
  useEffect(() => {
    if (sub !== "yaml" || !cluster) return;
    let cancelled = false;
    setYamlLoading(true);
    setYamlError("");
    getWorkloadYaml(cluster, row.namespace, row.name, kindK8s.toLowerCase())
      .then((r) => { if (!cancelled) setLiveYaml(r.yaml); })
      .catch((e: any) => { if (!cancelled) setYamlError(e?.message || "获取 YAML 失败"); })
      .finally(() => { if (!cancelled) setYamlLoading(false); });
    return () => { cancelled = true; };
  }, [sub, cluster, row.namespace, row.name, kindK8s]);

  // 编辑工作负载弹窗状态
  const [editOpen, setEditOpen] = useState(false);

  const paused = rollout ? rollout.paused : pausedFromRev;
  // 暂停 = 缩容到 0，只有有副本数概念的负载才支持（DaemonSet 由节点数决定副本，排除）
  const kindLower = kindK8s.toLowerCase();
  const scalable = kindLower === "deployment" || kindLower === "statefulset";

  // 进入详情时加载发布历史 + 暂停状态
  useEffect(() => {
    if (!cluster || isJob) return;
    const kind = kindK8s.toLowerCase();
    workloadRevisions(cluster, row.namespace, row.name, kind)
      .then((d) => { setRevisions(d.revisions || []); setPaused(!!d.paused); setResult(null); })
      .catch(() => { /* 非致命，忽略 */ });
  }, [cluster, type, tab, row.name, row.namespace, isJob, kindK8s]);

  const runAction = async (action: string, payload?: Record<string, unknown>, okMsg?: string) => {
    if (!cluster) return;
    setActionLoading(true);
    setResult(null);
    try {
      await workloadAction({ cluster, ns: row.namespace, name: row.name, kind: kindK8s.toLowerCase(), action, payload });
      setResult({ ok: true, msg: okMsg ?? "操作成功" });
      // 进入 60s 紧盯窗口并立刻重启轮询，让用户马上看到 Pod 的变化过程
      watchUntilRef.current = Date.now() + 60_000;
      setRefreshKey((k) => k + 1);
      // 刷新发布历史与暂停状态
      workloadRevisions(cluster, row.namespace, row.name, kindK8s.toLowerCase())
        .then((d) => { setRevisions(d.revisions || []); setPaused(!!d.paused); })
        .catch(() => {});
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message || "操作失败" });
    } finally {
      setActionLoading(false);
    }
  };

  const doRestart = () => runAction("restart", undefined, "重启指令已下发，正在滚动替换 Pod");
  const doPauseResume = () =>
    runAction(
      paused ? "resume" : "pause",
      undefined,
      paused ? "已恢复副本数，Pod 正在拉起" : "已缩容到 0，Pod 正在停止",
    );

  const openUpgrade = () => {
    if (!pods[0]?.containers?.length) {
      setResult({ ok: false, msg: "尚未获取到容器列表，请稍候重试" });
      return;
    }
    const init: Record<string, string> = {};
    pods[0].containers.forEach((c) => { init[c.name] = c.image; });
    setUpgradeImages(init);
    setUpgradeOpen(true);
  };

  const doUpgrade = async () => {
    const containers = Object.entries(upgradeImages).map(([name, image]) => ({ name, image }));
    if (!containers.length) return;
    setUpgradeOpen(false);
    await runAction("upgrade", { containers }, "升级已提交，正在滚动更新");
  };

  const openRollback = () => {
    // 默认选择“上一个版本”（最新版本之前的那条）
    const prev = revisions.find((r) => !r.current);
    setRollbackTarget(prev ? prev.revision : null);
    setRollbackOpen(true);
  };

  const doRollback = async () => {
    if (rollbackTarget == null) return;
    setRollbackOpen(false);
    await runAction("rollback", { revision: rollbackTarget }, `已回滚到 revision ${rollbackTarget}`);
  };

  // Pod 列表 + 滚动进度轮询。
  // 频率自适应：滚动更新进行中（或刚下发写操作）时 1.5s 一次，稳定后 10s 一次，
  // 这样用户点了重启就能实时看到新 Pod 拉起、旧 Pod 回收的全过程。
  useEffect(() => {
    if (!cluster || isJob) {
      setPodsLoading(false);
      setPods([]);
      setRollout(null);
      return;
    }
    const kind = kindK8s.toLowerCase();
    const url = `/workload-pods?cluster=${cluster}&ns=${encodeURIComponent(row.namespace)}&name=${encodeURIComponent(row.name)}&kind=${encodeURIComponent(kind)}`;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPodsLoading(true);

    const tick = async () => {
      try {
        const d = await apiGet<{ pods: PodInfo[]; rollout: RolloutStatus | null }>(url);
        if (stopped) return;
        setPods(d.pods || []);
        setRollout(d.rollout ?? null);
        setPodsError("");
        // 观察窗口：写操作后 60s 内保持高频，避免刚下发时后端状态还没翻转就降频
        const watching = Date.now() < watchUntilRef.current;
        const busy = d.rollout?.progressing || (d.pods || []).some((p) => p.deleting || !p.ready);
        timer = setTimeout(tick, busy || watching ? 1500 : 10000);
      } catch (e: any) {
        if (stopped) return;
        setPodsError(e?.message || "加载失败");
        setPods([]);
        setRollout(null);
        timer = setTimeout(tick, 10000);
      } finally {
        if (!stopped) setPodsLoading(false);
      }
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [cluster, type, tab, row.name, row.namespace, isJob, kindK8s, refreshKey]);

  const tabs: { k: "overview" | "pods" | "yaml" | "events"; label: string; icon: React.ReactNode }[] = [
    { k: "overview", label: "概览", icon: <Activity size={13} /> },
    { k: "pods", label: "容器组", icon: <Container size={13} /> },
    { k: "events", label: "事件", icon: <AlertTriangle size={13} /> },
    { k: "yaml", label: "YAML", icon: <FileText size={13} /> },
  ];

  const meta = metaByName[row.name] ?? fallbackMeta(row.name);

  const conditions = !isJob && (wl.ready === wl.desired && wl.restarts === 0)
    ? [
        { type: "Available", status: "True", message: "Deployment has minimum availability." },
        { type: "Progressing", status: "True", message: `ReplicaSet "${row.name}-${meta.revision ?? "1"}abcd12" has successfully progressed.` },
      ]
    : !isJob ? [
        { type: "Available", status: wl.ready > 0 ? "True" : "False", message: wl.ready > 0 ? `Minimum replicas available.` : `No replicas available.` },
        { type: "Progressing", status: wl.ready === wl.desired ? "True" : "False", message: `${wl.ready}/${wl.desired} replicas progressed.` },
      ] : [];

  type Ev = { type: string; reason: string; age: string; message: string };
  const events: Ev[] = !isJob ? [
    ...(wl.restarts > 0 ? [{ type: "Warning", reason: "BackOff", age: "12m", message: `容器重启${wl.restarts}次，可能存在健康检查失败或 OOM。` }] : []),
    { type: "Normal", reason: "Scheduled", age: "20d", message: `已成功调度到节点 ${wl.pods?.length ? "node-pool-1" : "n/a"}。` },
    { type: "Normal", reason: "SuccessfulCreate", age: "20d", message: `已创建 ReplicaSet ${row.name}-${meta.revision ?? "1"}abcd12。` },
    { type: "Normal", reason: "Pulled", age: "20d", message: `已拉取镜像 ${wl.image}。` },
    { type: "Normal", reason: "Created", age: "20d", message: `容器已创建。` },
    { type: "Normal", reason: "Started", age: "20d", message: `容器已启动。` },
  ] : [];

  return (
    <div className="space-y-4">
      {/* 面包屑 + 返回 */}
      <div className="flex items-center gap-2 text-[12px]">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line bg-surface text-ink-700 hover:border-brand-300 hover:text-brand-700 transition"
        >
          <ArrowLeft size={15} /> 返回
        </button>
        <span className="text-ink-300">/</span>
        <span className="text-ink-500">工作负载</span>
        <span className="text-ink-300">/</span>
        <span className="font-mono text-ink-900 font-semibold">{row.name}</span>
      </div>

      {/* 标题区 */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-line bg-surface shadow-sh-1 card-beam">
        <div className={cn("w-10 h-10 rounded-lg grid place-items-center", isJob ? "bg-cyan-100 text-cyan-600" : "bg-brand-50 text-brand-600")}>
          <Boxes size={18} />
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[15px] font-semibold text-ink-900 truncate">{row.name}</div>
          <div className="font-mono text-[11.5px] text-ink-400">{kindK8s} · {row.namespace}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatusBadge kind={row.status} label={status} />
          <span className="text-[11px] text-ink-400">更新于 {row.age}</span>
        </div>
      </div>

      {/* 操作栏：暂停 / 重启 / 升级 / 回滚（作用于真实集群） */}
      {!isJob && (
        <div className="rounded-lg border border-line bg-surface shadow-sh-1">
          {!clusterReady && (
            <div className="flex items-start gap-2 px-3 py-2 border-b border-line bg-warn/5 text-[12px] text-warn rounded-t-lg">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                集群 <span className="font-mono">{clusterName || "(未选择)"}</span> 当前不可用（{currentCluster?.healthMessage || "未配置 KubeConfig"}），工作负载写操作（暂停/重启/升级/回滚）已禁用。
                请前往 <span className="font-mono">平台治理 → 集群管理</span> 配置后重试。
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            {scalable && (
              <button
                onClick={() =>
                  paused
                    ? setConfirmState({
                        title: "确认恢复？",
                        body: `将把 ${row.name} 的副本数恢复为暂停前的数量，Pod 会重新拉起。`,
                        onConfirm: () => { setConfirmState(null); doPauseResume(); },
                      })
                    : setConfirmState({
                        title: "确认暂停？",
                        body: `将把 ${row.name} 缩容到 0 副本，所有 Pod 会被停止，服务将不可用。恢复时会自动还原当前副本数（${rollout?.desired ?? wl.desired}）。`,
                        onConfirm: () => { setConfirmState(null); doPauseResume(); },
                      })
                }
                disabled={actionLoading || !clusterReady}
                title={paused ? "恢复到暂停前的副本数" : "缩容到 0 副本（停止服务）"}
                className={cn(
                  "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium transition border disabled:opacity-40 disabled:cursor-not-allowed",
                  paused
                    ? "bg-ok/10 border-ok/40 text-ok hover:bg-ok/15"
                    : "bg-surface border-line text-ink-700 hover:border-brand-300 hover:text-brand-700",
                )}
              >
                {paused ? <Play size={15} /> : <Pause size={15} />}
                {paused ? "恢复" : "暂停"}
              </button>
            )}
            <button
              onClick={() => setConfirmState({ title: "确认重启？", body: `将对 ${row.name} 的所有 Pod 执行滚动重启，期间服务可能有短暂中断，确认继续？`, onConfirm: () => { setConfirmState(null); doRestart(); } })}
              disabled={actionLoading || !clusterReady}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-surface border border-line text-ink-700 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCw size={15} className={actionLoading ? "animate-spin" : ""} />
              重启
            </button>
            <button
              onClick={() => setEditOpen(true)}
              disabled={actionLoading || !clusterReady}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-surface border border-line text-ink-700 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Pencil size={15} />
              编辑
            </button>
            <button
              onClick={openUpgrade}
              disabled={actionLoading || !clusterReady}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-surface border border-line text-ink-700 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowUpToLine size={15} />
              升级
            </button>
            <button
              onClick={openRollback}
              disabled={actionLoading || !clusterReady || revisions.length < 2}
              title={!clusterReady ? "集群未就绪" : revisions.length < 2 ? "至少需要两次发布历史才能回滚" : "回滚到上一个版本"}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-surface border border-line text-ink-700 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Undo2 size={15} />
              回滚
            </button>

            {result && (
              <span className={cn("ml-auto inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md", result.ok ? "bg-ok/10 text-ok" : "bg-err/10 text-err")}>
                {result.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                {result.msg}
              </span>
            )}
          </div>

          {/* 滚动更新进度：重启/升级/回滚后实时反映新旧 Pod 的替换过程 */}
          {rollout && <RolloutBar rollout={rollout} pods={pods} />}
        </div>
      )}

      {/* 顶部 KPI 大数字 */}
      {!isJob ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {/* 就绪副本取实时轮询值，重启/暂停后立刻反映真实状态（列表数据刷新较慢） */}
          <Kpi
            icon={<CheckCircle2 size={14} />}
            label="就绪副本"
            value={rollout ? `${rollout.ready} / ${rollout.desired}` : `${wl.ready} / ${wl.desired}`}
            accent={
              rollout
                ? rollout.paused ? "info" : rollout.ready === rollout.desired ? "ok" : "warn"
                : wl.ready === wl.desired ? "ok" : "warn"
            }
          />
          <Kpi icon={<RotateCw size={13} />} label="重启次数" value={String(wl.restarts)} accent={wl.restarts === 0 ? "ok" : wl.restarts < 5 ? "info" : "warn"} />
          <Kpi icon={<Cpu size={13} />} label="CPU 请求" value={`${wl.cpu}m`} accent="brand" />
          <Kpi icon={<Layers size={13} />} label="内存请求" value={`${(wl.cpu / 500).toFixed(2)} Gi`} accent="brand" />
          <Kpi icon={<Clock size={13} />} label="运行时长" value={wl.age} accent="info" />
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={<CheckCircle2 size={14} />} label="完成 / 并行" value={`${jr.completions} / ${jr.parallelism}`} accent="ok" />
          <Kpi icon={<Clock size={13} />} label="运行时长" value={jr.duration} accent="brand" />
          {tab === "cronjob" && <Kpi icon={<Clock size={13} />} label="调度计划" value={jr.schedule ?? "—"} accent="info" />}
          {tab === "cronjob" && <Kpi icon={<Activity size={13} />} label="活跃实例" value={String(jr.active ?? 0)} accent="info" />}
        </div>
      )}

      {/* 子页签 */}
      <div className="flex p-0.5 bg-sunken rounded-lg border border-line w-fit">
        {tabs.map((t) => (
          <button
            key={t.k}
            onClick={() => setSub(t.k)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[12.5px] font-medium transition",
              sub === t.k ? "bg-surface text-brand-700 shadow-sh-1" : "text-ink-500 hover:text-ink-900",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 概览 - 双栏 + 满宽 pod 列表 */}
      {sub === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
            <div className="xl:col-span-7 space-y-4">
              <SectionCard title="资源信息" icon={<Boxes size={14} />}>
                <KV icon={<Layers size={13} />} k="类型" v={kindK8s} />
                <KV icon={<Hash size={13} />} k="命名空间" v={row.namespace} mono />
                <KV icon={<GitBranch size={13} />} k="副本策略" v={kindK8s === "StatefulSet" ? "OrderedReady" : kindK8s === "DaemonSet" ? "AllNodes" : "RollingUpdate"} mono />
                <KV icon={<Activity size={13} />} k="副本数" v={`${wl.desired}`} mono />
                <KV icon={<Box size={13} />} k="镜像" v={isJob ? jr.image : wl.image} mono />
                <KV icon={<Server size={13} />} k="Service Account" v="default" mono />
                <KV icon={<GitBranch size={13} />} k="镜像拉取策略" v="IfNotPresent" mono />
              </SectionCard>

              {!isJob && (
                <SectionCard title="容器配置" icon={<Container size={14} />} right={<span className="text-[11px] font-mono text-ink-400">{(pods[0]?.containers.length ?? 1)} 容器</span>}>
                  {pods[0]?.containers.map((c) => (
                    <div key={c.name} className="px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className={cn("w-2 h-2 rounded-full shrink-0", c.ready ? "bg-ok" : "bg-err")} />
                        <span className="font-mono text-[12.5px] font-semibold text-ink-900">{c.name}</span>
                        <span className="font-mono text-[10.5px] text-ink-400 truncate ml-1">{c.image}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 pl-4 text-[11px]">
                        <span className="text-ink-500">资源请求：<span className="font-mono text-ink-700">{wl.cpu}m / {(wl.cpu / 500).toFixed(2)}Gi</span></span>
                        <span className="text-ink-500">资源限制：<span className="font-mono text-ink-700">{wl.cpu * 2}m / {((wl.cpu * 2) / 500).toFixed(2)}Gi</span></span>
                        <span className="text-ink-500">端口：<span className="font-mono text-ink-700">—</span></span>
                        <span className="text-ink-500">存活探针：<span className="font-mono text-ink-700">HTTP GET /healthz :8080</span></span>
                      </div>
                    </div>
                  ))}
                </SectionCard>
              )}

              {!isJob && (
                <SectionCard
                  title="容器组 Pod"
                  icon={<Container size={14} />}
                  right={
                    <div className="flex items-center gap-2">
                      {podsLoading ? (
                        <Skeleton className="h-3 w-12 rounded" />
                      ) : (
                        <>
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-brand-50 text-brand-600">共 {pods.length} 个</span>
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-ok/10 text-ok">就绪 {pods.filter((p) => p.ready && !p.deleting).length}</span>
                          {pods.some((p) => p.deleting) && (
                            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-err/10 text-err">终止中 {pods.filter((p) => p.deleting).length}</span>
                          )}
                          {rollout?.progressing && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700">
                              <RotateCw size={10} className="animate-spin" /> 滚动中
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  }
                >
                  <PodInlineList
                    pods={pods}
                    loading={podsLoading}
                    error={podsError}
                    onLogs={(pod, c) => setActive({ pod, container: c, mode: "logs" })}
                    onExec={(pod, c) => setActive({ pod, container: c, mode: "exec" })}
                  />
                </SectionCard>
              )}
            </div>

            <div className="xl:col-span-5 space-y-4">
              {!isJob && conditions.length > 0 && (
                <SectionCard title="状态条件" icon={<Activity size={14} />}>
                  {conditions.map((c, i) => {
                    const isTrue = c.status === "True";
                    return (
                      <div key={i} className="px-3 py-2 flex items-start gap-2">
                        <span className={cn("w-2 h-2 mt-1.5 rounded-full shrink-0", isTrue ? "bg-ok" : "bg-err")} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-semibold text-ink-900">{c.type}</span>
                            <span className={cn("text-[10px] font-mono px-1.5 py-0.5 rounded border",
                              isTrue ? "bg-ok/10 border-ok/30 text-ok" : "bg-err/10 border-err/30 text-err")}>
                              {c.status}
                            </span>
                          </div>
                          <div className="text-[11px] text-ink-500 mt-0.5">{c.message}</div>
                        </div>
                      </div>
                    );
                  })}
                </SectionCard>
              )}

              <SectionCard title="标签 / 注解" icon={<Tag size={14} />}>
                {meta.labels.map(([k, v]) => (
                  <div key={k} className="px-3 py-1.5 flex items-center gap-2 text-[11.5px]">
                    <span className="font-mono text-brand-600 truncate">{k}</span>
                    <span className="text-ink-300">=</span>
                    <span className="font-mono text-ink-700 truncate">{v}</span>
                  </div>
                ))}
                {meta.annotations.length > 0 && (
                  <>
                    <div className="px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-wider text-ink-400 border-t border-line/60">注解</div>
                    {meta.annotations.map(([k, v]) => (
                      <div key={k} className="px-3 py-1.5 flex items-center gap-2 text-[11.5px]">
                        <span className="font-mono text-cyan-600 truncate">{k}</span>
                        <span className="text-ink-300">=</span>
                        <span className="font-mono text-ink-500 truncate">{v}</span>
                      </div>
                    ))}
                  </>
                )}
              </SectionCard>

              <SectionCard title="关联资源" icon={<Link2 size={14} />}>
                <ResLink icon={<Network size={12} className="text-brand-600" />} name="Service" value="kube-dns" ns={row.namespace} />
                <ResLink icon={<Network size={12} className="text-brand-600" />} name="EndpointSlice" value="kube-dns-abcde" ns={row.namespace} />
                <ResLink icon={<Server size={12} className="text-cyan-600" />} name="ConfigMap" value="coredns-custom" ns={row.namespace} />
                <ResLink icon={<Server size={12} className="text-cyan-600" />} name="ServiceAccount" value="coredns" ns={row.namespace} />
              </SectionCard>
            </div>
          </div>

          {!isJob && events.length > 0 && (
            <SectionCard title="最近事件" icon={<AlertTriangle size={14} />}>
              <div className="divide-y divide-line">
                {events.map((e, i) => (
                  <div key={i} className="px-3 py-2 flex items-start gap-3">
                    <span className={cn("shrink-0 w-1.5 h-1.5 mt-2 rounded-full", e.type === "Warning" ? "bg-warn" : "bg-ok")} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn("text-[10.5px] font-mono px-1.5 py-0.5 rounded border",
                          e.type === "Warning" ? "bg-warn/10 border-warn/30 text-warn" : "bg-ok/10 border-ok/30 text-ok")}>{e.type}</span>
                        <span className="text-[12px] font-semibold text-ink-900">{e.reason}</span>
                        <span className="ml-auto font-mono text-[11px] text-ink-400">{e.age}</span>
                      </div>
                      <div className="text-[11.5px] text-ink-500 mt-0.5 truncate">{e.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
        </div>
      )}

      {sub === "pods" && (
        <Card beam={false}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-subtle">
            <Container size={14} className="text-brand-600" />
            <div className="text-[13px] font-semibold text-ink-900">容器组（Pod）</div>
            {podsLoading ? (
              <Skeleton className="h-3 w-12 rounded" />
            ) : (
              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-brand-50 text-brand-600 ml-1">{pods.length} 个</span>
            )}
          </div>
          <div className="p-3">
            <PodInlineList
              pods={pods}
              loading={podsLoading}
              error={podsError}
              onLogs={(pod, c) => setActive({ pod, container: c, mode: "logs" })}
              onExec={(pod, c) => setActive({ pod, container: c, mode: "exec" })}
            />
          </div>
        </Card>
      )}

      {sub === "events" && (
        <Card beam={false}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-subtle">
            <AlertTriangle size={14} className="text-warn" />
            <div className="text-[13px] font-semibold text-ink-900">最近事件</div>
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-sunken text-ink-500 ml-1">{events.length} 条</span>
          </div>
          <div className="divide-y divide-line">
            {events.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px] text-ink-400">暂无事件</div>
            ) : events.map((e, i) => (
              <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                <span className={cn("shrink-0 w-1.5 h-1.5 mt-2 rounded-full", e.type === "Warning" ? "bg-warn" : "bg-ok")} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("text-[10.5px] font-mono px-1.5 py-0.5 rounded border",
                      e.type === "Warning" ? "bg-warn/10 border-warn/30 text-warn" : "bg-ok/10 border-ok/30 text-ok")}>{e.type}</span>
                    <span className="text-[12.5px] font-semibold text-ink-900">{e.reason}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-400 shrink-0">{e.age}</span>
                  </div>
                  <div className="text-[11.5px] text-ink-500 mt-0.5">{e.message}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {sub === "yaml" && (
        <Card beam={false}>
          <div className="flex items-center gap-1.5 px-4 py-3 border-b border-line bg-subtle text-[13px] font-semibold text-ink-900">
            <ScrollText size={15} className="text-brand-600" /> 资源清单（实时从集群读取）
          </div>
          <div className="p-3">
            {yamlLoading && (
              <div className="text-[12px] text-ink-400 py-6 text-center">正在从集群读取完整 YAML…</div>
            )}
            {yamlError && (
              <div className="text-[12px] text-err py-6 text-center">读取失败：{yamlError}</div>
            )}
            {!yamlLoading && !yamlError && (
              <textarea
                readOnly
                value={liveYaml || yaml}
                spellCheck={false}
                className="w-full h-[60vh] font-mono text-[12px] leading-relaxed text-ink-800 bg-sunken border border-line rounded-lg p-3 outline-none resize-none"
              />
            )}
          </div>
        </Card>
      )}

      {/* 日志 / 控制台 放大弹框 */}
      {active && createPortal(
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-ink-900/50 backdrop-blur-sm p-4"
          onClick={() => setActive(null)}
        >
          <div
            className="w-[92vw] max-w-6xl rounded-xl border border-line bg-surface shadow-sh-3 overflow-hidden card-beam"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-subtle">
              <span className="text-[13.5px] font-semibold text-ink-900">
                {active.mode === "logs" ? "容器日志" : "容器控制台"}
              </span>
              <span className="font-mono text-[11.5px] text-ink-400 truncate">
                {active.pod} / {active.container}
              </span>
              <button
                onClick={() => setActive(null)}
                className="ml-auto w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-sunken transition"
              >
                <X size={15} />
              </button>
            </div>
            <div className="h-[72vh]">
              {active.mode === "logs" ? (
                <LogPanel cluster={cluster} ns={row.namespace} pod={active.pod} container={active.container} />
              ) : (
                <ExecTerminal cluster={cluster} ns={row.namespace} pod={active.pod} container={active.container} />
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 升级弹窗：更换镜像版本 */}
      <Modal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        title="升级 · 更换镜像版本"
        desc="修改容器镜像后提交，将触发滚动更新"
        icon={<ArrowUpToLine size={15} />}
        footer={
          <>
            <button onClick={() => setUpgradeOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={doUpgrade} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">提交升级</button>
          </>
        }
      >
        <p className="text-[11.5px] text-ink-500">修改下列容器的镜像后提交以触发滚动更新；保持原值则不变更。</p>
        <div className="space-y-3">
          {Object.entries(upgradeImages).map(([name, img]) => (
            <Field key={name} label={name}>
              <ImagePicker
                value={img}
                onChange={(v) => setUpgradeImages((p) => ({ ...p, [name]: v }))}
                placeholder="registry/namespace/image:tag（也可点「选择」从镜像仓库选）"
              />
            </Field>
          ))}
        </div>
      </Modal>

      {/* 回滚弹窗：选择历史版本 */}
      <Modal
        open={rollbackOpen}
        onClose={() => setRollbackOpen(false)}
        title="回滚 · 选择版本"
        desc="回滚到选定的历史发布版本"
        icon={<Undo2 size={15} />}
        footer={
          <>
            <button onClick={() => setRollbackOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={doRollback} disabled={rollbackTarget == null} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50">回滚</button>
          </>
        }
      >
        <div className="space-y-2">
          {revisions.map((r) => (
            <button
              key={r.revision}
              onClick={() => setRollbackTarget(r.revision)}
              className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition", rollbackTarget === r.revision ? "border-brand-300 bg-brand-50" : "border-line hover:border-brand-200")}
            >
              <span className={cn("w-3.5 h-3.5 rounded-full border-2 shrink-0", rollbackTarget === r.revision ? "border-brand-600 bg-brand-600" : "border-ink-300")} />
              <span className="font-mono text-[12px] font-semibold text-ink-900">revision {r.revision}</span>
              {r.current && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ok/10 text-ok">当前</span>}
              <span
                className="font-mono text-[11px] text-ink-500 truncate ml-1 min-w-0 flex-1"
                title={r.image}
              >{r.image}</span>
              <span className="ml-auto font-mono text-[10.5px] text-ink-400 shrink-0">{r.age}</span>
            </button>
          ))}
        </div>
        {revisions.length < 2 && <p className="text-[11px] text-ink-400 mt-2">仅有一个发布版本时无法回滚，请先完成至少一次升级。</p>}
      </Modal>

      {/* 编辑工作负载弹窗：副本数 / 资源 / 端口 / 探活 / 命令 / 生命周期 */}
      <EditWorkloadModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        cluster={cluster}
        ns={row.namespace}
        name={row.name}
        kind={kindK8s}
        reload={reload}
      />

      {/* 危险操作二次确认 */}
      <Modal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={confirmState?.title ?? ""}
        icon={<AlertTriangle size={15} />}
        footer={
          <>
            <button onClick={() => setConfirmState(null)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={() => confirmState?.onConfirm()} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">确认</button>
          </>
        }
      >
        <p className="text-[12.5px] text-ink-600 leading-relaxed">{confirmState?.body}</p>
      </Modal>
    </div>
  );
}

// ============ 子组件 ============

// 编辑工作负载：副本数 / 资源请求+限制 / 端口 / 探活 / 启动命令 / 生命周期钩子。
// 预填来自 getWorkloadSpec（真实集群读回），保存调用 updateWorkload（Get+变更+Update，保留其余字段）。
function EditWorkloadModal({ open, onClose, cluster, ns, name, kind, reload }: {
  open: boolean; onClose: () => void;
  cluster: string; ns: string; name: string; kind: string; reload?: () => void;
}) {
  type PortRow = { name: string; port: string; protocol: string; hostPort: string };
  type EnvRow = { name: string; value: string };
  type ProbeRow = {
    enabled: boolean;
    type: "http" | "tcp" | "exec";
    path: string; port: string; scheme: string; command: string;
    initialDelay: string; period: string; timeout: string;
    failureThreshold: string; successThreshold: string;
  };
  type LcRow = { enabled: boolean; type: "exec" | "http"; command: string; path: string; port: string; scheme: string };

  const scalable = kind.toLowerCase() === "deployment" || kind.toLowerCase() === "statefulset";
  const kindLower = kind.toLowerCase(); // 后端接口只认小写 kind（deployment/statefulset/...）
  const emptyProbe = (): ProbeRow => ({ enabled: false, type: "http", path: "/", port: "", scheme: "HTTP", command: "", initialDelay: "", period: "", timeout: "", failureThreshold: "", successThreshold: "" });
  const emptyLc = (): LcRow => ({ enabled: false, type: "exec", command: "", path: "/", port: "", scheme: "HTTP" });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [containerName, setContainerName] = useState("");
  const [replicas, setReplicas] = useState("");
  const [image, setImage] = useState("");
  const [cpu, setCpu] = useState(""); const [mem, setMem] = useState("");
  const [cpuReq, setCpuReq] = useState(""); const [memReq, setMemReq] = useState("");
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [probes, setProbes] = useState<{ livenessProbe: ProbeRow; readinessProbe: ProbeRow; startupProbe: ProbeRow }>({ livenessProbe: emptyProbe(), readinessProbe: emptyProbe(), startupProbe: emptyProbe() });
  const [lifecycle, setLifecycle] = useState<{ postStart: LcRow; preStop: LcRow }>({ postStart: emptyLc(), preStop: emptyLc() });

  const toProbeRow = (p?: ProbeParam | null): ProbeRow => p ? ({
    enabled: true,
    type: (p.type as ProbeRow["type"]) || "http",
    path: p.path || "/",
    port: p.port != null ? String(p.port) : "",
    scheme: p.scheme || "HTTP",
    command: (p.command || []).join(" "),
    initialDelay: p.initialDelaySeconds ? String(p.initialDelaySeconds) : "",
    period: p.periodSeconds ? String(p.periodSeconds) : "",
    timeout: p.timeoutSeconds ? String(p.timeoutSeconds) : "",
    failureThreshold: p.failureThreshold ? String(p.failureThreshold) : "",
    successThreshold: p.successThreshold ? String(p.successThreshold) : "",
  }) : emptyProbe();

  const toLcRow = (h?: LifecycleHandlerParam | null): LcRow => h ? ({
    enabled: true,
    type: (h.type as LcRow["type"]) || "exec",
    command: (h.command || []).join(" "),
    path: h.path || "/",
    port: h.port != null ? String(h.port) : "",
    scheme: h.scheme || "HTTP",
  }) : emptyLc();

  useEffect(() => {
    if (!open) return;
    setLoading(true); setErr("");
    getWorkloadSpec(cluster, ns, name, kindLower)
      .then((spec) => {
        setContainerName(spec.container.name);
        setReplicas(scalable ? String(spec.replicas) : "");
        setImage(spec.container.image || "");
        setCpu(spec.container.cpu || ""); setMem(spec.container.mem || "");
        setCpuReq(spec.container.cpuReq || ""); setMemReq(spec.container.memReq || "");
        setPorts((spec.container.ports || []).map((p) => ({ name: p.name || "", port: String(p.containerPort), protocol: p.protocol || "TCP", hostPort: p.hostPort ? String(p.hostPort) : "" })));
        setEnv((spec.container.env || []).map((e) => ({ name: e.name, value: e.value || "" })));
        setCommand((spec.container.command || []).join(" "));
        setArgs((spec.container.args || []).join(" "));
        setProbes({ livenessProbe: toProbeRow(spec.container.livenessProbe), readinessProbe: toProbeRow(spec.container.readinessProbe), startupProbe: toProbeRow(spec.container.startupProbe) });
        setLifecycle({ postStart: toLcRow(spec.container.lifecycle?.postStart), preStop: toLcRow(spec.container.lifecycle?.preStop) });
      })
      .catch((e: any) => setErr(e?.message || "加载失败"))
      .finally(() => setLoading(false));
  }, [open, cluster, ns, name, kind, scalable]);

  const serializeProbe = (row: ProbeRow): ProbeParam | undefined => {
    if (!row.enabled) return undefined;
    const num = (s: string) => { const n = Number(s); return n > 0 ? n : undefined; };
    const p: ProbeParam = { type: row.type };
    if (row.type === "http") {
      p.path = row.path || "/";
      p.port = Number(row.port) || undefined;
      p.scheme = row.scheme || "HTTP";
    } else if (row.type === "tcp") {
      p.port = Number(row.port) || undefined;
    } else {
      p.command = row.command.trim() ? row.command.trim().split(/\s+/) : undefined;
    }
    p.initialDelaySeconds = num(row.initialDelay);
    p.periodSeconds = num(row.period);
    p.timeoutSeconds = num(row.timeout);
    p.failureThreshold = num(row.failureThreshold);
    p.successThreshold = num(row.successThreshold);
    if (row.type !== "exec" && !p.port) return undefined;
    if (row.type === "exec" && !p.command) return undefined;
    return p;
  };

  const serializeLifecycle = (lc: { postStart: LcRow; preStop: LcRow }): EditableSpec["container"]["lifecycle"] => {
    const out: any = {};
    (["postStart", "preStop"] as const).forEach((key) => {
      const h = lc[key];
      if (!h.enabled) return;
      if (h.type === "http") {
        if (!h.port.trim()) return;
        out[key] = { type: "http", path: h.path || "/", port: Number(h.port), scheme: h.scheme || "HTTP" };
      } else {
        if (!h.command.trim()) return;
        out[key] = { type: "exec", command: h.command.trim().split(/\s+/) };
      }
    });
    return Object.keys(out).length ? out : undefined;
  };

  const setProbe = (key: "livenessProbe" | "readinessProbe" | "startupProbe", patch: Partial<ProbeRow>) =>
    setProbes((p) => ({ ...p, [key]: { ...p[key], ...patch } }));
  const setLc = (key: "postStart" | "preStop", patch: Partial<LcRow>) =>
    setLifecycle((p) => ({ ...p, [key]: { ...p[key], ...patch } }));

  const doSave = async () => {
    if (!image.trim()) { setErr("镜像不能为空"); return; }
    setSaving(true); setErr("");
    const spec: EditableSpec = {
      kind: kindLower,
      replicas: scalable ? (Number(replicas) || 0) : -1,
      container: {
        name: containerName,
        image: image.trim(),
        cpu: cpu.trim(), mem: mem.trim(), cpuReq: cpuReq.trim(), memReq: memReq.trim(),
        ports: ports.filter((p) => p.port.trim()).map((p) => ({
          name: p.name.trim() || undefined,
          containerPort: Number(p.port),
          protocol: p.protocol || "TCP",
          hostPort: p.hostPort.trim() ? Number(p.hostPort) : undefined,
        })),
        command: command.trim() ? command.trim().split(/\s+/) : undefined,
        args: args.trim() ? args.trim().split(/\s+/) : undefined,
        env: env.filter((e) => e.name.trim()).map((e) => ({ name: e.name.trim(), value: e.value })),
        livenessProbe: serializeProbe(probes.livenessProbe),
        readinessProbe: serializeProbe(probes.readinessProbe),
        startupProbe: serializeProbe(probes.startupProbe),
        lifecycle: serializeLifecycle(lifecycle),
      },
    };
    try {
      await updateWorkload(cluster, ns, name, kindLower, spec);
      reload?.();
      onClose();
    } catch (e: any) {
      setErr(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const probeDefs = [
    { key: "livenessProbe" as const, label: "存活探针", desc: "探测失败重启容器" },
    { key: "readinessProbe" as const, label: "就绪探针", desc: "探测失败摘除流量" },
    { key: "startupProbe" as const, label: "启动探针", desc: "启动期间优先探测" },
  ];
  const lcDefs = [
    { key: "postStart" as const, label: "启动后命令 (PostStart)", desc: "容器启动后立即执行" },
    { key: "preStop" as const, label: "启动前命令 (PreStop)", desc: "容器终止前执行" },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxW="max-w-3xl"
      title="编辑工作负载"
      desc={`${kind} · ${ns}/${name} — 变更将实时写入集群`}
      icon={<Pencil size={15} />}
      bodyClassName="pt-0 px-4 pb-4 space-y-3.5"
      footer={
        <>
          <button onClick={onClose} disabled={saving} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition disabled:opacity-40">取消</button>
          <button onClick={doSave} disabled={saving || loading} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50">{saving ? "保存中…" : "保存"}</button>
        </>
      }
    >
      {loading && <div className="text-[12px] text-ink-400 py-6 text-center">正在从集群读取当前配置…</div>}
      {err && <div className="text-[12px] text-err bg-err/10 border border-err/30 rounded-lg px-3 py-2">{err}</div>}
      {!loading && (
        <div className="space-y-4">
          {/* 基本信息（首块卡片去掉顶边/顶圆角，与头部连成一体，消除顶部留白） */}
          <div className="rounded-b-lg border border-line border-t-0 bg-surface p-3.5 space-y-3">
            <div className="flex items-center gap-1.5">
              <Boxes size={13} className="text-brand-600" />
              <span className="text-[12.5px] font-semibold text-ink-800">基本信息</span>
            </div>
            {scalable && (
              <Field label="副本数"><TextInput type="number" min={0} value={replicas} onChange={(e) => setReplicas(e.target.value)} placeholder="1" /></Field>
            )}
            <Field label="镜像"><ImagePicker value={image} onChange={setImage} placeholder="registry/namespace/image:tag（也可点「选择」从镜像仓库选）" /></Field>
          </div>

          {/* 资源 */}
          <div className="rounded-lg border border-line bg-surface p-3.5 space-y-3">
            <div className="flex items-center gap-1.5">
              <Cpu size={13} className="text-brand-600" />
              <span className="text-[12.5px] font-semibold text-ink-800">资源（请求 / 限制）</span>
              <span className="text-[10.5px] text-ink-400 ml-1">CPU 毫核，内存 K8s Quantity（Mi/Gi）</span>
            </div>
            <div className="grid grid-cols-4 gap-2.5">
              <Field label="CPU 请求"><TextInput value={cpuReq} onChange={(e) => setCpuReq(e.target.value)} placeholder="100" /></Field>
              <Field label="CPU 限制"><TextInput value={cpu} onChange={(e) => setCpu(e.target.value)} placeholder="200" /></Field>
              <Field label="内存请求"><TextInput value={memReq} onChange={(e) => setMemReq(e.target.value)} placeholder="256Mi" /></Field>
              <Field label="内存限制"><TextInput value={mem} onChange={(e) => setMem(e.target.value)} placeholder="512Mi" /></Field>
            </div>
          </div>

          {/* 端口 */}
          <div className="rounded-lg border border-line bg-surface p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Network size={13} className="text-brand-600" />
                <span className="text-[12.5px] font-semibold text-ink-800">端口</span>
              </div>
              <button type="button" onClick={() => setPorts([...ports, { name: "", port: "", protocol: "TCP", hostPort: "" }])} className="h-7 px-2.5 rounded-md border border-line text-[11.5px] text-ink-700 hover:bg-sunken inline-flex items-center gap-1"><Plus size={11} /> 添加端口</button>
            </div>
            {ports.length === 0 && <div className="text-[11.5px] text-ink-400 py-1 text-center">尚未配置端口</div>}
            <div className="space-y-2">
              {ports.map((p, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <select value={p.protocol} onChange={(e) => setPorts(ports.map((x, j) => j === i ? { ...x, protocol: e.target.value } : x))} className="h-8 px-2 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300">
                    <option>TCP</option><option>UDP</option><option>SCTP</option>
                  </select>
                  <input value={p.name} onChange={(e) => setPorts(ports.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="名称（多端口必填）" className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300 font-mono" />
                  <input value={p.port} onChange={(e) => setPorts(ports.map((x, j) => j === i ? { ...x, port: e.target.value } : x))} placeholder="容器端口" className="h-8 px-2.5 w-24 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300 font-mono" />
                  <input value={p.hostPort} onChange={(e) => setPorts(ports.map((x, j) => j === i ? { ...x, hostPort: e.target.value } : x))} placeholder="Host端口" className="h-8 px-2.5 w-20 rounded-md border border-line bg-surface text-[11.5px] outline-none focus:border-brand-300 font-mono" />
                  <button type="button" onClick={() => setPorts(ports.filter((_, j) => j !== i))} className="w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-err-bg hover:text-err transition"><Trash2 size={11} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* 环境变量 */}
          <div className="rounded-lg border border-line bg-surface p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Tag size={13} className="text-brand-600" />
                <span className="text-[12.5px] font-semibold text-ink-800">环境变量</span>
              </div>
              <button type="button" onClick={() => setEnv([...env, { name: "", value: "" }])} className="h-7 px-2.5 rounded-md border border-line text-[11.5px] text-ink-700 hover:bg-sunken inline-flex items-center gap-1"><Plus size={11} /> 添加变量</button>
            </div>
            {env.length === 0 && <div className="text-[11.5px] text-ink-400 py-1 text-center">尚未配置环境变量</div>}
            <div className="space-y-2">
              {env.map((e, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={e.name} onChange={(ev) => setEnv(env.map((x, j) => j === i ? { ...x, name: ev.target.value } : x))} placeholder="变量名" className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300" />
                  <span className="text-ink-300">=</span>
                  <input value={e.value} onChange={(ev) => setEnv(env.map((x, j) => j === i ? { ...x, value: ev.target.value } : x))} placeholder="值" className="h-8 px-2.5 flex-1 rounded-md border border-line bg-surface text-[11.5px] font-mono outline-none focus:border-brand-300" />
                  <button type="button" onClick={() => setEnv(env.filter((_, j) => j !== i))} className="w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-err-bg hover:text-err transition"><Trash2 size={11} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* 启动命令 */}
          <div className="rounded-lg border border-line bg-surface p-3.5 space-y-2.5">
            <div className="flex items-center gap-1.5">
              <TerminalIcon size={13} className="text-brand-600" />
              <span className="text-[12.5px] font-semibold text-ink-800">启动命令</span>
              <span className="text-[10.5px] text-ink-400 ml-1">覆盖镜像默认 ENTRYPOINT（空格分隔参数）</span>
            </div>
            <Field label="command"><TextInput value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/bin/sh -c" className="font-mono" /></Field>
            <Field label="args"><TextInput value={args} onChange={(e) => setArgs(e.target.value)} placeholder="node server.js --port 8080" className="font-mono" /></Field>
          </div>

          {/* 健康检查 */}
          <div className="rounded-lg border border-line bg-surface p-3.5 space-y-3">
            <div className="flex items-center gap-1.5">
              <Activity size={13} className="text-brand-600" />
              <span className="text-[12.5px] font-semibold text-ink-800">健康检查（探活）</span>
            </div>
            {probeDefs.map((pr) => {
              const row = probes[pr.key];
              return (
                <div key={pr.key} className="rounded-lg border border-line bg-subtle p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-ink-800">{pr.label}</span>
                      <span className="text-[10.5px] text-ink-400">{pr.desc}</span>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-ink-600 cursor-pointer">
                      <input type="checkbox" checked={row.enabled} onChange={(e) => setProbe(pr.key, { enabled: e.target.checked })} className="rounded border-line text-brand-600 focus:ring-brand-200" />
                      启用
                    </label>
                  </div>
                  {row.enabled && (
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-ink-500 w-14">类型</span>
                        <SelectInput value={row.type} onChange={(e) => setProbe(pr.key, { type: e.target.value as ProbeRow["type"] })}>
                          <option value="http">HTTP 请求</option>
                          <option value="tcp">TCP 端口</option>
                          <option value="exec">执行命令</option>
                        </SelectInput>
                      </div>
                      {row.type === "http" && (
                        <div className="grid grid-cols-3 gap-2">
                          <Field label="路径"><TextInput value={row.path} onChange={(e) => setProbe(pr.key, { path: e.target.value })} placeholder="/healthz" /></Field>
                          <Field label="端口"><TextInput value={row.port} onChange={(e) => setProbe(pr.key, { port: e.target.value })} placeholder="8080" /></Field>
                          <Field label="协议"><SelectInput value={row.scheme} onChange={(e) => setProbe(pr.key, { scheme: e.target.value })}><option>HTTP</option><option>HTTPS</option></SelectInput></Field>
                        </div>
                      )}
                      {row.type === "tcp" && (
                        <Field label="端口"><TextInput value={row.port} onChange={(e) => setProbe(pr.key, { port: e.target.value })} placeholder="8080" /></Field>
                      )}
                      {row.type === "exec" && (
                        <Field label="命令" hint="空格分隔多个参数"><TextInput value={row.command} onChange={(e) => setProbe(pr.key, { command: e.target.value })} placeholder="cat /tmp/healthy" className="font-mono" /></Field>
                      )}
                      <div className="grid grid-cols-5 gap-2">
                        <Field label="延迟(s)"><TextInput value={row.initialDelay} onChange={(e) => setProbe(pr.key, { initialDelay: e.target.value })} placeholder="10" /></Field>
                        <Field label="间隔(s)"><TextInput value={row.period} onChange={(e) => setProbe(pr.key, { period: e.target.value })} placeholder="10" /></Field>
                        <Field label="超时(s)"><TextInput value={row.timeout} onChange={(e) => setProbe(pr.key, { timeout: e.target.value })} placeholder="1" /></Field>
                        <Field label="失败阈值"><TextInput value={row.failureThreshold} onChange={(e) => setProbe(pr.key, { failureThreshold: e.target.value })} placeholder="3" /></Field>
                        <Field label="成功阈值"><TextInput value={row.successThreshold} onChange={(e) => setProbe(pr.key, { successThreshold: e.target.value })} placeholder="1" /></Field>
                      </div>
                      <div className="text-[10px] text-ink-400">阈值留空则使用 Kubernetes 默认值</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 生命周期钩子 */}
          <div className="rounded-lg border border-line bg-surface p-3.5 space-y-3">
            <div className="flex items-center gap-1.5">
              <RotateCw size={13} className="text-brand-600" />
              <span className="text-[12.5px] font-semibold text-ink-800">生命周期钩子</span>
              <span className="text-[10.5px] text-ink-400 ml-1">启动后 / 启动前命令</span>
            </div>
            {lcDefs.map((lc) => {
              const row = lifecycle[lc.key];
              return (
                <div key={lc.key} className="rounded-lg border border-line bg-subtle p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-ink-800">{lc.label}</span>
                      <span className="text-[10.5px] text-ink-400">{lc.desc}</span>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-ink-600 cursor-pointer">
                      <input type="checkbox" checked={row.enabled} onChange={(e) => setLc(lc.key, { enabled: e.target.checked })} className="rounded border-line text-brand-600 focus:ring-brand-200" />
                      启用
                    </label>
                  </div>
                  {row.enabled && (
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-ink-500 w-14">类型</span>
                        <SelectInput value={row.type} onChange={(e) => setLc(lc.key, { type: e.target.value as LcRow["type"] })}>
                          <option value="exec">执行命令</option>
                          <option value="http">HTTP 请求</option>
                        </SelectInput>
                      </div>
                      {row.type === "http" && (
                        <div className="grid grid-cols-3 gap-2">
                          <Field label="路径"><TextInput value={row.path} onChange={(e) => setLc(lc.key, { path: e.target.value })} placeholder="/healthz" /></Field>
                          <Field label="端口"><TextInput value={row.port} onChange={(e) => setLc(lc.key, { port: e.target.value })} placeholder="8080" /></Field>
                          <Field label="协议"><SelectInput value={row.scheme} onChange={(e) => setLc(lc.key, { scheme: e.target.value })}><option>HTTP</option><option>HTTPS</option></SelectInput></Field>
                        </div>
                      )}
                      {row.type === "exec" && (
                        <Field label="命令" hint="空格分隔多个参数"><TextInput value={row.command} onChange={(e) => setLc(lc.key, { command: e.target.value })} placeholder="/bin/sh -c" className="font-mono" /></Field>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Kpi({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent: "ok" | "warn" | "info" | "brand" | "err" }) {
  const accentCls: Record<string, string> = {
    ok: "text-ok border-ok/30 bg-ok/5",
    warn: "text-warn border-warn/30 bg-warn/5",
    info: "text-info border-info/30 bg-info/5",
    err: "text-err border-err/30 bg-err/5",
    brand: "text-brand-600 border-brand-200 bg-brand-50",
  };
  return (
    <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-line bg-surface shadow-sh-1 hover-glow transition">
      <div className={cn("w-10 h-10 rounded-lg grid place-items-center border", accentCls[accent])}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[10.5px] text-ink-400 uppercase tracking-wider">{label}</div>
        <div className="font-mono text-[16px] font-semibold text-ink-900 truncate">{value}</div>
      </div>
    </div>
  );
}

function SectionCard({ title, icon, right, children }: { title: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface shadow-sh-1 hover-glow transition overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line bg-subtle">
        {icon && <span className="text-brand-600">{icon}</span>}
        <div className="text-[12.5px] font-semibold text-ink-900">{title}</div>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

function KV({ icon, k, v, mono }: { icon: React.ReactNode; k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-ink-400 shrink-0">{icon}</span>
      <span className="text-[11.5px] text-ink-500 w-28 shrink-0">{k}</span>
      <span className={cn("text-[12px] text-ink-900 truncate font-medium", mono && "font-mono")}>{v}</span>
    </div>
  );
}

function ResLink({ icon, name, value, ns }: { icon: React.ReactNode; name: string; value: string; ns?: string }) {
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 text-[11.5px]">
      <span className="w-5 h-5 rounded grid place-items-center bg-sunken shrink-0">{icon}</span>
      <span className="text-ink-500 shrink-0">{name}</span>
      <span className="font-mono text-ink-900 truncate">{value}</span>
      {ns && <span className="ml-auto font-mono text-[10px] text-ink-400 shrink-0">{ns}</span>}
    </div>
  );
}

// 容器组列表 - 默认展开，每容器一行 + 两个大按钮
function PodInlineList({
  pods, loading, error,
  onLogs, onExec,
}: {
  pods: PodInfo[];
  loading: boolean;
  error: string;
  onLogs: (pod: string, container: string) => void;
  onExec: (pod: string, container: string) => void;
}) {
  if (loading) {
    return (
      <div className="px-3 py-6 flex items-center justify-center">
        <span className="text-[11.5px] text-ink-400">正在从集群加载 Pod…</span>
      </div>
    );
  }
  if (error) {
    return <div className="px-3 py-3 text-[11.5px] text-err">{error}</div>;
  }
  if (pods.length === 0) {
    return <div className="px-3 py-6 text-center text-[11.5px] text-ink-400">暂无运行中的 Pod</div>;
  }
  return (
    <div className="divide-y divide-line/60">
      {pods.map((p) => {
        const phase = p.deleting
          ? "Terminating"
          : p.status === "ok" || p.status === "Running" ? "Running" : p.status === "Pending" ? "Pending" : p.status === "Failed" ? "Failed" : p.status === "Succeeded" ? "Succeeded" : "Unknown";
        const fresh = !p.deleting && isFreshPod(p);
        return (
          <div
            key={p.name}
            className={cn(
              "px-3 py-3 transition-colors",
              p.deleting && "opacity-60 bg-err/[0.03]",
              fresh && "bg-cyan-50/40",
            )}
          >
            <div className="flex items-center gap-2.5 mb-2.5">
              <span className={cn("w-2.5 h-2.5 rounded-[3px] shrink-0", p.deleting ? "bg-err/50" : podColor[p.status] ?? "bg-ink-300")} />
              <span className={cn("font-mono text-[13px] font-semibold truncate", p.deleting ? "text-ink-500 line-through" : "text-ink-900")}>{p.name}</span>
              <span className={cn("text-[10.5px] font-mono px-1.5 py-0.5 rounded border shrink-0", podStatusBg[phase] ?? "bg-sunken border-line text-ink-400")}>{phase}</span>
              {/* 滚动更新期间的身份标记：一眼看出哪个是新起的、哪个是待淘汰的 */}
              {fresh && <Chip tone="cyan" text="新拉起" />}
              {!p.deleting && !p.updated && <Chip tone="warn" text="旧版本" />}
              <span className="ml-auto flex items-center gap-3 text-[10.5px] font-mono text-ink-400 shrink-0">
                <span>存活 <span className="text-ink-600 tabular-nums">{p.age}</span></span>
                <span>重启 <span className={cn("font-semibold tabular-nums", p.restarts === 0 ? "text-ok" : p.restarts < 5 ? "text-info" : "text-warn")}>{p.restarts}</span></span>
                <span>Node <span className="text-ink-600">{p.node.split("/").pop() ?? p.node}</span></span>
                <span className="text-ink-500">{p.podIP}</span>
              </span>
            </div>
            <div className="space-y-1.5 pl-5">
              {p.containers.map((c) => {
                const distroless = /coredns|distroless|gcr\.io\/distroless/i.test(c.image);
                return (
                  <div key={c.name} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-subtle/40 border border-line/60">
                    <span className={cn("w-2 h-2 rounded-full shrink-0", c.ready ? "bg-ok" : "bg-err")} />
                    <span className="font-mono text-[12px] font-semibold text-ink-900 truncate min-w-0">{c.name}</span>
                    <span className="font-mono text-[10.5px] text-ink-400 truncate flex-1 min-w-0" title={c.image}>
                      {c.image.length > 64 ? c.image.slice(0, 60) + "…" : c.image}
                    </span>
                    {distroless && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warn/10 text-warn border border-warn/30 shrink-0" title="distroless 镜像无 shell，控制台不可用">无 shell</span>
                    )}
                    <div className="flex items-center gap-2 shrink-0">
                      <BigBtn
                        tone="brand"
                        small
                        icon={<ScrollText size={13} />}
                        label="日志"
                        onClick={() => onLogs(p.name, c.name)}
                      />
                      <BigBtn
                        tone="cyan"
                        small
                        icon={<TerminalIcon size={13} />}
                        label="控制台"
                        onClick={() => onExec(p.name, c.name)}
                        disabled={distroless || !c.ready}
                        title={distroless ? "该容器为 distroless 镜像，无 shell" : !c.ready ? "容器未就绪" : undefined}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 ml-5 flex items-center gap-1.5">
              {p.containers.map((c) => (
                <span key={c.name} className={cn("h-1 flex-1 rounded-full", c.ready ? "bg-ok" : "bg-err/30")} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 滚动更新进度条：把 desired/updated/ready/available 与新旧 Pod 数量摊开展示，
// 让"点了重启到底发生了什么"这件事在页面上肉眼可见。
function RolloutBar({ rollout, pods }: { rollout: RolloutStatus; pods: PodInfo[] }) {
  const live = pods.filter((p) => !p.deleting);
  const fresh = live.filter((p) => isFreshPod(p)).length;
  const terminating = pods.filter((p) => p.deleting).length;
  const oldVer = live.filter((p) => !p.updated).length;
  const desired = Math.max(rollout.desired, 1);
  const pct = (n: number) => `${Math.min(100, Math.round((n / desired) * 100))}%`;

  const tone = rollout.paused ? "idle" : rollout.progressing ? "run" : "ok";
  const toneCls = {
    idle: "bg-ink-100 text-ink-500 border-ink-200",
    run: "bg-cyan-50 text-cyan-700 border-cyan-200",
    ok: "bg-ok/10 text-ok border-ok/30",
  }[tone];

  return (
    <div className="px-3 pb-3 pt-0.5 border-t border-line/60">
      <div className="flex items-center gap-2 mb-2 mt-2">
        <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] font-medium px-2 py-0.5 rounded-md border", toneCls)}>
          {rollout.progressing ? (
            <RotateCw size={12} className="animate-spin" />
          ) : rollout.paused ? (
            <Pause size={12} />
          ) : (
            <CheckCircle2 size={12} />
          )}
          {rollout.message}
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] font-mono text-ink-500">
          <span>期望 <b className="text-ink-800 tabular-nums">{rollout.desired}</b></span>
          <span>已更新 <b className="text-cyan-700 tabular-nums">{rollout.updated}</b></span>
          <span>就绪 <b className="text-ok tabular-nums">{rollout.ready}</b></span>
          <span>可用 <b className="text-ink-800 tabular-nums">{rollout.available}</b></span>
        </div>
      </div>

      {/* 双层进度条：底层=已更新，上层=已就绪 */}
      <div className="relative h-2 rounded-full bg-sunken overflow-hidden border border-line/60">
        <div
          className="absolute inset-y-0 left-0 bg-cyan-400/50 transition-all duration-500"
          style={{ width: pct(rollout.updated) }}
        />
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-all duration-500",
            rollout.progressing ? "bg-gradient-to-r from-brand-500 to-cyan-500" : "bg-ok",
          )}
          style={{ width: pct(rollout.ready) }}
        />
      </div>

      {(fresh > 0 || terminating > 0 || oldVer > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {fresh > 0 && <Chip tone="cyan" text={`新拉起 ${fresh}`} />}
          {oldVer > 0 && <Chip tone="warn" text={`旧版本 ${oldVer}`} />}
          {terminating > 0 && <Chip tone="err" text={`终止中 ${terminating}`} />}
        </div>
      )}
    </div>
  );
}

function Chip({ tone, text }: { tone: "cyan" | "warn" | "err" | "ok"; text: string }) {
  const cls = {
    cyan: "bg-cyan-50 text-cyan-700 border-cyan-200",
    warn: "bg-warn/10 text-warn border-warn/30",
    err: "bg-err/10 text-err border-err/30",
    ok: "bg-ok/10 text-ok border-ok/30",
  }[tone];
  return <span className={cn("text-[10.5px] font-mono px-1.5 py-0.5 rounded border", cls)}>{text}</span>;
}

function BigBtn({
  tone, icon, label, onClick, disabled, small, title,
}: {
  tone: "brand" | "cyan";
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  small?: boolean;
  title?: string;
}) {
  const base = small ? "h-8 px-3 text-[12px] gap-1.5" : "h-10 px-4 text-[13.5px] gap-2";
  const style =
    tone === "brand"
      ? "bg-gradient-to-r from-brand-600 to-cyan-500 text-white shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 active:opacity-90"
      : "bg-white border-2 border-cyan-500 text-cyan-700 hover:bg-cyan-50 active:bg-cyan-100";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-semibold transition select-none",
        base,
        style,
        disabled && "opacity-40 cursor-not-allowed hover:opacity-40",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function buildYaml(row: Workload | JobRow, type: "workload" | "job", kindK8s: string, tab: WType): string {
  const ns = row.namespace;
  const name = row.name;
  if (type === "job") {
    const jr = row as JobRow;
    const api = "batch/v1";
    const cron = tab === "cronjob";
    const scheduleLine = cron ? `  schedule: "${jr.schedule ?? "* * * * *"}"\n` : "";
    return `apiVersion: ${api}
kind: ${kindK8s}
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
spec:
${scheduleLine}  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${jr.image}
      restartPolicy: ${jr.status === "err" ? "Never" : "OnFailure"}`;
  }
  const wl = row as Workload;
  return `apiVersion: apps/v1
kind: ${kindK8s}
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
spec:
  replicas: ${wl.desired}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${wl.image}
          resources:
            requests:
              cpu: ${wl.cpu}m
              memory: ${(wl.cpu / 500).toFixed(1)}Gi`;
}

function PodBars({ pods }: { pods?: string[] | null }) {
  return (
    <div className="flex items-center gap-[2.5px]">
      {(pods ?? []).map((p, i) => (
        <span key={i} className={cn("w-[5px] h-3.5 rounded-[2px]", podColor[p] ?? "bg-ink-300")} />
      ))}
    </div>
  );
}

// FoldCard 折叠卡片：左侧图标 + 标题 + 副标题，右侧展开/收起箭头；展开时显示 children。
function FoldCard({ open, onToggle, icon, title, hint, children }: {
  open: boolean; onToggle: () => void; icon: React.ReactNode;
  title: string; hint?: string; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-sunken transition text-left"
      >
        {icon}
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink-800">{title}</div>
          {hint && <div className="text-[10.5px] text-ink-400 mt-0.5 truncate">{hint}</div>}
        </div>
        <ChevronDown size={13} className={cn("ml-auto text-ink-400 transition", open && "rotate-180")} />
      </button>
      {open && <div className="px-3.5 pb-3.5 pt-1 border-t border-line">{children}</div>}
    </div>
  );
}
