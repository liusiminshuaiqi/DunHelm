import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

// 流水线「部署」节点的结构化配置编辑器。
// 这些字段在后端以 JSON 字符串存储（ports_json / env_json / volumes_json / probes_json），
// 前端用可视化表单填写，避免用户手写 JSON。JSON 形状严格对齐 server/internal/ci/deploy.go 的解析器。

const inp =
  "w-full h-8 px-2 text-[12px] rounded-md border border-line bg-surface outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100";
const sel =
  "h-8 px-2 text-[12px] rounded-md border border-line bg-surface outline-none focus:border-brand-300 cursor-pointer";

function safeArr<T>(v: string): T[] {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? (a as T[]) : [];
  } catch {
    return [];
  }
}
function safeObj<T>(v: string): T {
  try {
    const o = JSON.parse(v || "{}");
    return o && typeof o === "object" ? (o as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

const rowCls = "flex items-center gap-1.5";
const delBtn =
  "shrink-0 w-7 h-7 grid place-items-center rounded-md border border-line text-ink-400 hover:text-err hover:border-err/40 transition";

/* ---------------- 容器端口 ---------------- */
interface PortRow {
  name: string;
  containerPort: string;
  protocol: string;
  hostPort: string;
}
export function ContainerPortsEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rows, setRows] = useState<PortRow[]>(() =>
    safeArr<any>(value).map((x) => ({
      name: x.name ?? "",
      containerPort: x.containerPort != null ? String(x.containerPort) : "",
      protocol: x.protocol || "TCP",
      hostPort: x.hostPort != null && x.hostPort ? String(x.hostPort) : "",
    })),
  );
  const emit = (next: PortRow[]) => {
    setRows(next);
    const clean = next
      .filter((r) => Number(r.containerPort) > 0)
      .map((r) => ({
        name: r.name || undefined,
        containerPort: Number(r.containerPort),
        protocol: r.protocol || "TCP",
        hostPort: Number(r.hostPort) || 0,
      }));
    onChange(JSON.stringify(clean));
  };
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2">
      {rows.length === 0 && <div className="text-[11px] text-ink-400 py-1">暂无端口，点击下方添加容器端口。</div>}
      {rows.map((r, i) => (
        <div key={i} className={rowCls}>
          <input
            className={cn(inp, "flex-[1.1]")}
            type="number"
            min={1}
            max={65535}
            placeholder="容器端口"
            value={r.containerPort}
            onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, containerPort: e.target.value } : x)))}
          />
          <select className={cn(sel, "flex-1")} value={r.protocol} onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, protocol: e.target.value } : x)))}>
            <option>TCP</option>
            <option>UDP</option>
            <option>SCTP</option>
          </select>
          <input className={cn(inp, "flex-[1.4]")} placeholder="名称（可选，多端口必填）" value={r.name} onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className={cn(inp, "flex-[0.9]")} type="number" placeholder="HostPort" value={r.hostPort} onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, hostPort: e.target.value } : x)))} />
          <button className={delBtn} onClick={() => emit(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button
        className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-brand-600 hover:text-brand-700"
        onClick={() => emit([...rows, { name: "", containerPort: "", protocol: "TCP", hostPort: "" }])}
      >
        <Plus size={13} /> 添加端口
      </button>
    </div>
  );
}

/* ---------------- 环境变量 ---------------- */
interface EnvRow { name: string; value: string; }
export function EnvVarsEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rows, setRows] = useState<EnvRow[]>(() =>
    safeArr<any>(value).map((x) => ({ name: x.name ?? "", value: x.value ?? "" })),
  );
  const emit = (next: EnvRow[]) => {
    setRows(next);
    onChange(JSON.stringify(next.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), value: r.value }))));
  };
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2">
      {rows.length === 0 && <div className="text-[11px] text-ink-400 py-1">暂无变量，点击下方添加。</div>}
      {rows.map((r, i) => (
        <div key={i} className={rowCls}>
          <input className={cn(inp, "flex-1 font-mono")} placeholder="NAME" value={r.name} onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <span className="text-ink-300 text-[12px]">=</span>
          <input className={cn(inp, "flex-[1.6] font-mono")} placeholder="value" value={r.value} onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button className={delBtn} onClick={() => emit(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-brand-600 hover:text-brand-700" onClick={() => emit([...rows, { name: "", value: "" }])}>
        <Plus size={13} /> 添加变量
      </button>
    </div>
  );
}

/* ---------------- 数据卷挂载 ---------------- */
interface VolRow {
  name: string;
  type: string;
  claim: string;
  sizeLimit: string;
  path: string;
  hostPathType: string;
  refName: string;
  mountPath: string;
  subPath: string;
  readOnly: boolean;
}
const VOL_TYPES = ["pvc", "emptyDir", "hostPath", "configMap", "secret"];
export function VolumeMountsEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rows, setRows] = useState<VolRow[]>(() =>
    safeArr<any>(value).map((x) => ({
      name: x.name ?? "",
      type: x.type || "pvc",
      claim: x.claim ?? "",
      sizeLimit: x.sizeLimit ?? "",
      path: x.path ?? "",
      hostPathType: x.hostPathType ?? "",
      refName: x.refName ?? "",
      mountPath: x.mountPath ?? "",
      subPath: x.subPath ?? "",
      readOnly: !!x.readOnly,
    })),
  );
  const emit = (next: VolRow[]) => {
    setRows(next);
    onChange(JSON.stringify(next.filter((r) => r.name.trim() && r.mountPath.trim()).map((r) => ({
      name: r.name.trim(),
      type: r.type,
      claim: r.type === "pvc" ? r.claim : undefined,
      sizeLimit: r.type === "emptyDir" ? r.sizeLimit || undefined : undefined,
      path: r.type === "hostPath" ? r.path : undefined,
      hostPathType: r.type === "hostPath" ? r.hostPathType || undefined : undefined,
      refName: (r.type === "configMap" || r.type === "secret") ? r.refName : undefined,
      mountPath: r.mountPath.trim(),
      subPath: r.subPath || undefined,
      readOnly: r.readOnly || undefined,
    }))));
  };
  const set = (i: number, patch: Partial<VolRow>) => emit(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface p-2">
      {rows.length === 0 && <div className="text-[11px] text-ink-400 py-1">暂无挂载，点击下方添加数据卷。</div>}
      {rows.map((r, i) => (
        <div key={i} className="rounded-md border border-line bg-sunken/40 p-2 space-y-1.5">
          <div className={rowCls}>
            <input className={cn(inp, "flex-1")} placeholder="卷名（容器内引用名）" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
            <select className={cn(sel, "flex-1")} value={r.type} onChange={(e) => set(i, { type: e.target.value })}>
              {VOL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className={delBtn} onClick={() => emit(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
          </div>
          <div className={rowCls}>
            <input className={cn(inp, "flex-1")} placeholder={r.type === "pvc" ? "PVC 名称" : r.type === "configMap" || r.type === "secret" ? "ConfigMap/Secret 名称" : r.type === "hostPath" ? "宿主机路径" : "sizeLimit（如 1Gi，可选）"} value={r.type === "pvc" ? r.claim : r.type === "configMap" || r.type === "secret" ? r.refName : r.type === "hostPath" ? r.path : r.sizeLimit} onChange={(e) => {
              if (r.type === "pvc") set(i, { claim: e.target.value });
              else if (r.type === "configMap" || r.type === "secret") set(i, { refName: e.target.value });
              else if (r.type === "hostPath") set(i, { path: e.target.value });
              else set(i, { sizeLimit: e.target.value });
            }} />
            {r.type === "hostPath" && (
              <input className={cn(inp, "flex-1")} placeholder="hostPathType" value={r.hostPathType} onChange={(e) => set(i, { hostPathType: e.target.value })} />
            )}
          </div>
          <div className={rowCls}>
            <input className={cn(inp, "flex-[1.4]")} placeholder="挂载路径（如 /data）" value={r.mountPath} onChange={(e) => set(i, { mountPath: e.target.value })} />
            <input className={cn(inp, "flex-1")} placeholder="子路径（可选）" value={r.subPath} onChange={(e) => set(i, { subPath: e.target.value })} />
            <label className="shrink-0 flex items-center gap-1 text-[11px] text-ink-600 select-none">
              <input type="checkbox" checked={r.readOnly} onChange={(e) => set(i, { readOnly: e.target.checked })} /> 只读
            </label>
          </div>
        </div>
      ))}
      <button className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-brand-600 hover:text-brand-700" onClick={() => emit([...rows, { name: "", type: "pvc", claim: "", sizeLimit: "", path: "", hostPathType: "", refName: "", mountPath: "", subPath: "", readOnly: false }])}>
        <Plus size={13} /> 添加数据卷
      </button>
    </div>
  );
}

/* ---------------- 健康检查（探针） ---------------- */
type ProbeKey = "liveness" | "readiness" | "startup";
interface ProbeState {
  enabled: boolean;
  type: string;
  path: string;
  port: string;
  scheme: string;
  command: string;
  initialDelay: string;
  period: string;
  timeout: string;
  failureThreshold: string;
}
const PROBE_LABELS: Record<ProbeKey, string> = { liveness: "存活探针 Liveness", readiness: "就绪探针 Readiness", startup: "启动探针 Startup" };

export function ProbesEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const blob = safeObj<Record<ProbeKey, any>>(value);
  const [states, setStates] = useState<Record<ProbeKey, ProbeState>>(() => {
    const from = (p: any): ProbeState => ({
      enabled: !!p,
      type: p?.type || "http",
      path: p?.path ?? "",
      port: p?.port != null ? String(p.port) : "",
      scheme: p?.scheme || "HTTP",
      command: Array.isArray(p?.command) ? p.command.join(" ") : p?.command ?? "",
      initialDelay: p?.initialDelaySeconds != null ? String(p.initialDelaySeconds) : "",
      period: p?.periodSeconds != null ? String(p.periodSeconds) : "",
      timeout: p?.timeoutSeconds != null ? String(p.timeoutSeconds) : "",
      failureThreshold: p?.failureThreshold != null ? String(p.failureThreshold) : "",
    });
    return { liveness: from(blob.liveness), readiness: from(blob.readiness), startup: from(blob.startup) };
  });
  const emit = (next: Record<ProbeKey, ProbeState>) => {
    setStates(next);
    const out: Record<string, any> = {};
    (Object.keys(next) as ProbeKey[]).forEach((k) => {
      const s = next[k];
      if (!s.enabled) return;
      const o: any = { type: s.type };
      if (s.type === "http") {
        o.path = s.path;
        o.port = Number(s.port) || 0;
        o.scheme = s.scheme || "HTTP";
      } else if (s.type === "tcp") {
        o.port = Number(s.port) || 0;
      } else {
        o.command = s.command.split(/\s+/).filter(Boolean);
      }
      if (Number(s.initialDelay) > 0) o.initialDelaySeconds = Number(s.initialDelay);
      if (Number(s.period) > 0) o.periodSeconds = Number(s.period);
      if (Number(s.timeout) > 0) o.timeoutSeconds = Number(s.timeout);
      if (Number(s.failureThreshold) > 0) o.failureThreshold = Number(s.failureThreshold);
      out[k] = o;
    });
    onChange(JSON.stringify(out));
  };
  const setProbe = (k: ProbeKey, patch: Partial<ProbeState>) => emit({ ...states, [k]: { ...states[k], ...patch } });
  return (
    <div className="space-y-2">
      {(Object.keys(PROBE_LABELS) as ProbeKey[]).map((k) => {
        const s = states[k];
        return (
          <div key={k} className="rounded-lg border border-line bg-surface p-2">
            <label className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-700 cursor-pointer">
              <input type="checkbox" checked={s.enabled} onChange={(e) => setProbe(k, { enabled: e.target.checked })} />
              {PROBE_LABELS[k]}
            </label>
            {s.enabled && (
              <div className="mt-1.5 space-y-1.5">
                <div className={rowCls}>
                  <select className={cn(sel, "flex-1")} value={s.type} onChange={(e) => setProbe(k, { type: e.target.value })}>
                    <option value="http">HTTP GET</option>
                    <option value="tcp">TCP 端口</option>
                    <option value="exec">Exec 命令</option>
                  </select>
                  <input className={cn(inp, "flex-1")} type="number" placeholder="端口" value={s.port} onChange={(e) => setProbe(k, { port: e.target.value })} />
                  {s.type === "http" && (
                    <select className={cn(sel, "flex-1")} value={s.scheme} onChange={(e) => setProbe(k, { scheme: e.target.value })}>
                      <option>HTTP</option>
                      <option>HTTPS</option>
                    </select>
                  )}
                </div>
                {s.type === "http" && (
                  <input className={cn(inp, "font-mono")} placeholder="请求路径（如 /healthz）" value={s.path} onChange={(e) => setProbe(k, { path: e.target.value })} />
                )}
                {s.type === "exec" && (
                  <input className={cn(inp, "font-mono")} placeholder="命令（空格分隔，如 /bin/sh -c cat /tmp/ok）" value={s.command} onChange={(e) => setProbe(k, { command: e.target.value })} />
                )}
                <div className={rowCls}>
                  <input className={cn(inp, "flex-1")} type="number" placeholder="初始延迟(s)" value={s.initialDelay} onChange={(e) => setProbe(k, { initialDelay: e.target.value })} />
                  <input className={cn(inp, "flex-1")} type="number" placeholder="检测周期(s)" value={s.period} onChange={(e) => setProbe(k, { period: e.target.value })} />
                  <input className={cn(inp, "flex-1")} type="number" placeholder="超时(s)" value={s.timeout} onChange={(e) => setProbe(k, { timeout: e.target.value })} />
                  <input className={cn(inp, "flex-1")} type="number" placeholder="失败阈值" value={s.failureThreshold} onChange={(e) => setProbe(k, { failureThreshold: e.target.value })} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 命名空间下拉：从「部署实际目标集群」（第一个已连接集群）拉取真实命名空间列表。
// 与后端 RunDeploy 的集群选择逻辑一致：store.Clusters() 中第一个 KubeConfig 非空（connected）的集群。
// 若没有已连接集群或拉取失败，退化成文本输入，不阻断用户填写。
interface ClusterLite {
  id: number;
  name: string;
  connected: boolean;
  health?: string;
}
interface NsLite {
  name: string;
}

export function NamespaceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [clusterName, setClusterName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const clusters = await apiGet<ClusterLite[]>("/clusters");
        const target =
          clusters.find((c) => c.connected && c.health === "ready") ||
          clusters.find((c) => c.connected) ||
          null;
        if (!target) {
          if (!alive) return;
          setFailed(true);
          setLoading(false);
          return;
        }
        const ns = await apiGet<NsLite[]>(`/namespaces?cluster=${target.id}`);
        if (!alive) return;
        const list = Array.from(new Set(ns.map((x) => x.name).filter(Boolean)));
        setClusterName(target.name);
        setNamespaces(list);
        setLoading(false);
      } catch {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <select disabled className={cn(sel, "w-full bg-sunken cursor-wait text-ink-400")}>
        <option>加载集群命名空间…</option>
      </select>
    );
  }

  if (failed) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="default"
        className={cn(inp, "w-full")}
      />
    );
  }

  const opts = Array.from(new Set([...(value ? [value] : []), ...namespaces]));
  return (
    <div className="space-y-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(sel, "w-full")}
      >
        {opts.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      {clusterName && (
        <div className="text-[10px] text-ink-400">来源集群：{clusterName}（{namespaces.length} 个命名空间）</div>
      )}
    </div>
  );
}

// 构建集群下拉：列出平台已 Connected=true 的 K8s 集群（/api/clusters），供流水线 CI 阶段选择真实构建目标。
// 值为集群 id（数字），未选时为空串，后端会按「Store.Clusters() 首个 Connected」回退。
// 拉取失败时退化为文本输入（便于高级用户手填 cluster id）。

export function ClusterSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [list, setList] = useState<ClusterLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all = await apiGet<ClusterLite[]>("/clusters");
        if (!alive) return;
        setList(all.filter((c) => c.connected));
        setLoading(false);
      } catch {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <select disabled className={cn(sel, "w-full bg-sunken cursor-wait text-ink-400")}>
        <option>加载构建集群…</option>
      </select>
    );
  }
  if (failed) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="集群 id（回退按首个 Connected 集群）"
        className={cn(inp, "w-full")}
      />
    );
  }
  if (list.length === 0) {
    return (
      <div className="text-[11px] text-ink-500 px-2 py-1 border border-dashed border-ink-200 rounded">
        暂无已连接的构建集群；请先在「集群管理」中配置 kubeconfig。引擎将自动回退到合成 mock 日志。
      </div>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(sel, "w-full")}
    >
      <option value="">（默认 · 首个 Connected 集群）</option>
      {list.map((c) => (
        <option key={c.id} value={String(c.id)}>
          #{c.id} {c.name}
        </option>
      ))}
    </select>
  );
}

// 镜像仓库下拉：列出平台已连接的镜像仓库（/api/registries），供「推送镜像」节点选择目标仓库。
// 无连接仓库或拉取失败时退化为文本输入。
interface RegistryLite {
  id: number;
  name: string;
  type: string;
  url: string;
}

export function RegistrySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [list, setList] = useState<RegistryLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const regs = await apiGet<RegistryLite[]>("/registries");
        if (!alive) return;
        setList(regs.filter((r) => r && r.name));
        setLoading(false);
      } catch {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <select disabled className={cn(sel, "w-full bg-sunken cursor-wait text-ink-400")}>
        <option>加载镜像仓库…</option>
      </select>
    );
  }

  if (failed || list.length === 0) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="registry.local（无已连接仓库，可手填地址）"
        className={cn(inp, "w-full font-mono")}
      />
    );
  }

  const opts = Array.from(new Set([...(value ? [value] : []), ...list.map((r) => registryHost(r))]));
  return (
    <div className="space-y-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(sel, "w-full")}
      >
        {opts.map((o) => {
          const matched = list.find((r) => registryHost(r) === o);
          return (
            <option key={o} value={o}>
              {matched ? `${matched.name}（${matched.url}）` : o}
            </option>
          );
        })}
      </select>
      <div className="text-[10px] text-ink-400">已连接 {list.length} 个镜像仓库</div>
    </div>
  );
}

// registryHost 取仓库地址（去掉协议前缀），作为镜像引用前缀。
function registryHost(r: RegistryLite): string {
  let u = (r.url || "").trim();
  u = u.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (u === "") u = r.name || "registry.local";
  return u;
}
