import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Card, CardHead, KpiStat, StatusBadge, Modal, Field, TextInput, SelectInput, PrimaryButton, ErrorBanner, TableSkeleton, KpiSkeleton, usePagination, Pagination, SearchSelect } from "@/components/ui/primitives";
import { useServices, useIngresses, useCredentials, useNamespaces } from "@/data/useLive";
import {
  createService,
  createIngress,
  deleteService,
  deleteIngress,
  updateService,
  updateIngress,
  generateIngressCert,
  type ServicePortInput,
} from "@/lib/api";
import { getCluster } from "@/lib/cluster";
import { Network as NetIcon, Globe, Share2, ShieldCheck, Plus, RefreshCw, FileText, Pencil, Trash2, Search, Layers } from "lucide-react";
import { WorkloadPicker, type WorkloadPick } from "@/components/WorkloadPicker";

export function Network() {
  const liveSvc = useServices();
  const liveIng = useIngresses();
  const namespaces = useNamespaces();
  const services = liveSvc as any;
  const ingresses = liveIng as any;
  const loadingSvc = services._loading === true;
  const loadingIng = ingresses._loading === true;
  const errSvc = (services as any)._error as string | undefined;
  const errIng = (ingresses as any)._error as string | undefined;
  const reloadSvc: () => void = (services as any).reload ?? (() => {});
  const reloadIng: () => void = (ingresses as any).reload ?? (() => {});

  // 代码凭证库中的 TLS 凭证（供 Ingress HTTPS 选择已有证书）
  const credentials = useCredentials() as any;
  const tlsCredentials = Array.isArray(credentials) ? credentials.filter((c: any) => c.type === "TLS") : [];
  const onPickPort = (port: string) => {
    if (!selectedSvc) return;
    setIng((st) => ({ ...st, backend: `${selectedSvc.name}:${port}` }));
  };

  // KPI（从真实列表派生）
  const serviceCount = Array.isArray(services) ? services.length : 0;
  const ingressCount = Array.isArray(ingresses) ? ingresses.length : 0;
  const lbCount = Array.isArray(services) ? services.filter((s: any) => s.type === "LoadBalancer").length : 0;
  const exposedSvc = Array.isArray(services)
    ? services.filter((s: any) => s.type === "LoadBalancer" || s.type === "NodePort").length
    : 0;
  const loadingAny = loadingSvc || loadingIng;

  // 顶部 Tab + 搜索
  const [tab, setTab] = useState<"svc" | "ing">("svc");
  const [search, setSearch] = useState("");

  const svcRows = useMemo(() => {
    const list = Array.isArray(services) ? (services as any[]) : [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s: any) => (s.name || "").toLowerCase().includes(q) || (s.namespace || "").toLowerCase().includes(q));
  }, [services, search]);
  const ingRows = useMemo(() => {
    const list = Array.isArray(ingresses) ? (ingresses as any[]) : [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((g: any) => (g.host || "").toLowerCase().includes(q) || (g.name || "").toLowerCase().includes(q) || (g.namespace || "").toLowerCase().includes(q));
  }, [ingresses, search]);

  const svcPage = usePagination(svcRows.length);
  const ingPage = usePagination(ingRows.length);
  const activeRows = tab === "svc" ? svcRows : ingRows;
  const activePage = tab === "svc" ? svcPage : ingPage;
  const activeLoading = tab === "svc" ? loadingSvc : loadingIng;

  // 切 Tab / 改搜索时回填到第 1 页
  useEffect(() => { svcPage.setPage(1); ingPage.setPage(1); }, [tab, search]);

  const [svcOpen, setSvcOpen] = useState(false);
  const [ingOpen, setIngOpen] = useState(false);
  const [svc, setSvc] = useState({
    name: "",
    namespace: "default",
    type: "ClusterIP",
    ports: [{ port: 8080, targetPort: 8080, protocol: "TCP" }] as ServicePortInput[],
    selector: "app=myapp",
  });
  const [ing, setIng] = useState({ namespace: "default", host: "", path: "/", backend: "my-svc:8080", tls: "true", secretName: "", certMode: "select", _svcKey: "" });
  // TLS 证书：选中的 secret 名（来自凭证库选择或随机生成）；生成中状态与提示
  const [certSecret, setCertSecret] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genMsg, setGenMsg] = useState("");
  // 「指定工作负载」二级选择 — 选中后 chip 显示在 selector 上方，并把 labels 合并进 selector
  const [linkedWorkload, setLinkedWorkload] = useState<WorkloadPick | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const updSvc = (k: keyof typeof svc) => (e: { target: { value: string } }) => setSvc((s) => ({ ...s, [k]: e.target.value }));
  const updIng = (k: keyof typeof ing) => (e: { target: { value: string } }) => setIng((s) => ({ ...s, [k]: e.target.value }));

  // 把真实集群 Service 列表解析为「服务选择」与「端口选择」选项
  const serviceList = Array.isArray(services) ? services : [];
  const parseServicePorts = (portsStr: string): string[] => {
    const out = new Set<string>();
    (portsStr || "")
      .split(/[,;]/)
      .map((seg) => seg.trim().split(":")[0].trim())
      .filter((p) => p !== "")
      .forEach((p) => out.add(p));
    return Array.from(out);
  };
  // 当前选中的服务对象（SelectInput value 用 ns/name，避免跨命名空间重名）
  const selectedSvc = serviceList.find((s: any) => `${s.namespace}/${s.name}` === (ing as any)._svcKey) as any;
  const svcPorts = selectedSvc ? parseServicePorts(selectedSvc.ports) : [];
  const onPickService = (key: string) => {
    const s = serviceList.find((x: any) => `${x.namespace}/${x.name}` === key) as any;
    if (!s) return;
    // 默认取第一个端口；自动把命名空间同步为服务所在 ns（Ingress 须与后端同 ns）
    const ports = parseServicePorts(s.ports);
    const port = ports[0] ?? "80";
    setIng((st) => ({ ...st, backend: `${s.name}:${port}`, namespace: s.namespace, _svcKey: key }));
  };

  // 解析 / 序列化「k=v,k2=v2」形式的 selector 字符串（与后端 parseSelector 行为一致）
  const parseSelectorStr = (txt: string): Record<string, string> => {
    const out: Record<string, string> = {};
    txt.split(",").forEach((kv) => {
      const m = /^([^=]+)=(.*)$/.exec(kv.trim());
      if (m && m[1].trim()) out[m[1].trim()] = m[2].trim();
    });
    return out;
  };
  const joinSelector = (m: Record<string, string>): string =>
    Object.entries(m)
      .filter(([k]) => !!k)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  // 把后端返回的 "8080:8080/TCP, 443:8443/TCP" 端口串解析为结构化数组（编辑时回填）
  const parsePortsStr = (txt: string): ServicePortInput[] => {
    const out: ServicePortInput[] = [];
    (txt || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((part) => {
        let proto = "TCP";
        let rest = part;
        const slash = part.lastIndexOf("/");
        if (slash >= 0) {
          proto = (part.slice(slash + 1).trim() || "TCP").toUpperCase();
          rest = part.slice(0, slash);
        }
        const [p, tp] = rest.split(":").map((x) => parseInt(x.trim(), 10));
        const port = isNaN(p) ? 0 : p;
        out.push({ port, targetPort: isNaN(tp) ? port : tp, protocol: proto });
      });
    if (out.length === 0) out.push({ port: 80, targetPort: 80, protocol: "TCP" });
    return out;
  };
  const onPickWorkload = (w: WorkloadPick) => {
    setLinkedWorkload(w);
    // 合并规则：现有 selector 键值优先，workload labels 仅做补充
    const cur = parseSelectorStr(svc.selector);
    const merged = { ...w.labels, ...cur };
    setSvc((s) => {
      const next: typeof svc = { ...s, selector: joinSelector(merged) };
      // 所选工作负载声明了容器端口 → 同步进端口映射（服务端口=容器端口=targetPort，协议沿用）
      if (w.containerPorts && w.containerPorts.length > 0) {
        next.ports = w.containerPorts.map((cp) => ({
          port: cp.port,
          targetPort: cp.port,
          protocol: cp.protocol || "TCP",
        }));
      }
      return next;
    });
    setPickerOpen(false);
  };
  // 移除关联的 workload 但不回滚 selector：用户可能已经基于自动填入的 labels 又手动改过
  const clearLinkedWorkload = () => setLinkedWorkload(null);

  // 创建失败（含未选集群）的提示
  const [createErr, setCreateErr] = useState<string | null>(null);

  // 详情/编辑弹窗状态
  const [detailKind, setDetailKind] = useState<"svc" | "ing" | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailSvc, setDetailSvc] = useState<any>(null);
  const [detailIng, setDetailIng] = useState<any>(null);
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editSvcSelector, setEditSvcSelector] = useState("");
  const [editSvcAnnot, setEditSvcAnnot] = useState("");
  const [editSvcPorts, setEditSvcPorts] = useState<ServicePortInput[]>([{ port: 80, targetPort: 80, protocol: "TCP" }]);
  const [editSvcType, setEditSvcType] = useState("ClusterIP");
  const [editIngPath, setEditIngPath] = useState("/");
  const [editIngBackend, setEditIngBackend] = useState("");
  const [editIngTls, setEditIngTls] = useState("true");

  // 删除状态 + 二次确认
  const [pendingDelete, setPendingDelete] = useState<{ kind: "svc" | "ing"; name: string; ns: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const reloadAll = () => { reloadSvc(); reloadIng(); (credentials as any).reload?.(); };

  const openDetail = (kind: "svc" | "ing", item: any) => {
    const cid = getCluster();
    if (!cid) return;
    setDetailKind(kind);
    setDetailLoading(true);
    setDetailErr(null);
    setEditMode(false);
    if (kind === "svc") {
      setDetailSvc(item);
      setEditSvcSelector(item.selector || "");
      setEditSvcAnnot(item.annotations || "");
      setEditSvcPorts(parsePortsStr(item.ports));
      setEditSvcType(item.type || "ClusterIP");
    } else {
      setDetailIng(item);
      setEditIngPath(item.path || "/");
      setEditIngBackend(item.backend || "");
      setEditIngTls(item.tls ? "true" : "false");
    }
    setDetailLoading(false);
  };

  const closeDetail = () => {
    setDetailKind(null);
    setDetailSvc(null);
    setDetailIng(null);
    setDetailErr(null);
    setEditMode(false);
  };

  const onDeleteFromDetail = () => {
    const kind = detailKind;
    if (!kind) return;
    const name = kind === "svc" ? detailSvc?.name : detailIng?.name;
    const ns = kind === "svc" ? detailSvc?.namespace : detailIng?.namespace;
    setPendingDelete({ kind, name, ns });
    closeDetail();
  };

  const parseKeyValue = (txt: string): Record<string, string> => {
    const out: Record<string, string> = {};
    txt.split(/\n+/).forEach((line) => {
      const m = /^([^=]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1].trim()] = m[2].trim();
    });
    return out;
  };
  const parseSelector = (txt: string): Record<string, string> => parseSelectorStr(txt);

  const saveEdit = async () => {
    const cid = getCluster();
    if (!cid) return;
    setEditSaving(true);
    setDetailErr(null);
    try {
      if (detailKind === "svc" && detailSvc) {
        const d = await updateService(cid, detailSvc.namespace, detailSvc.name, {
          selector: parseSelector(editSvcSelector),
          annotations: parseKeyValue(editSvcAnnot),
          type: editSvcType,
          ports: editSvcPorts.map((p) => ({
            port: Number(p.port) || 0,
            targetPort: Number(p.targetPort) || Number(p.port) || 0,
            protocol: (p.protocol || "TCP").toUpperCase(),
          })),
        });
        setDetailSvc(d);
      } else if (detailKind === "ing" && detailIng) {
        const d = await updateIngress(cid, detailIng.namespace, detailIng.name, {
          path: editIngPath,
          backend: editIngBackend,
          tls: editIngTls === "true",
        });
        setDetailIng(d);
      }
      setEditMode(false);
      reloadAll();
    } catch (e: any) {
      setDetailErr(e?.message ?? String(e));
    } finally {
      setEditSaving(false);
    }
  };

  const confirmDelete = async () => {
    const pd = pendingDelete;
    if (!pd) return;
    const cid = getCluster();
    if (!cid) {
      setDeleteErr("请先选择集群");
      return;
    }
    setDeleting(true);
    setDeleteErr(null);
    try {
      if (pd.kind === "svc") await deleteService(cid, pd.ns, pd.name);
      else await deleteIngress(cid, pd.ns, pd.name);
      setPendingDelete(null);
      reloadAll();
    } catch (e: any) {
      setDeleteErr(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  };

  const createSvc = async () => {
    if (!svc.name) return;
    setCreateErr(null);
    try {
      const cid = getCluster();
      if (!cid) {
        setCreateErr("请先选择集群（Service 需在真实集群创建）");
        return;
      }
      await createService(cid, {
        ...svc,
        ports: svc.ports.map((p) => ({
          port: Number(p.port) || 0,
          targetPort: Number(p.targetPort) || Number(p.port) || 0,
          protocol: (p.protocol || "TCP").toUpperCase(),
        })),
      });
      setSvc({ name: "", namespace: "default", type: "ClusterIP", ports: [{ port: 8080, targetPort: 8080, protocol: "TCP" }], selector: "app=myapp" });
      setLinkedWorkload(null);
      setSvcOpen(false);
      reloadAll();
    } catch (e: any) {
      setCreateErr(e?.message ?? String(e));
    }
  };

  // 调用后端生成自签名证书（落 K8s Secret 并登记凭证库），返回 secretName
  const doGenerateCert = async (cid: string, host: string, ns: string): Promise<string> => {
    const r = await generateIngressCert(cid, host, ns);
    return r.secretName;
  };

  const generateCert = async () => {
    if (!ing.host) {
      setGenMsg("请先在上方填写「域名」后再生成证书");
      return;
    }
    setGenLoading(true);
    setGenMsg("");
    try {
      const cid = getCluster();
      if (!cid) {
        setGenMsg("请先选择集群");
        return;
      }
      const secretName = await doGenerateCert(cid, ing.host, ing.namespace);
      setCertSecret(secretName);
      setGenMsg(`已生成自签名证书 secret \`${secretName}\` 并写入代码凭证库`);
    } catch (e: any) {
      setGenMsg(e?.message ?? String(e));
    } finally {
      setGenLoading(false);
    }
  };

  const createIng = async () => {
    if (!ing.host) return;
    setCreateErr(null);
    try {
      const cid = getCluster();
      if (!cid) {
        setCreateErr("请先选择集群（Ingress 需在真实集群创建）");
        return;
      }
      const useTLS = ing.tls === "true";
      let secret = certSecret;
      // HTTPS 必有证书：若选「随机生成」且尚未生成，则自动生成一次
      if (useTLS && ing.certMode === "generate" && !secret) {
        secret = await doGenerateCert(cid, ing.host, ing.namespace);
        setCertSecret(secret);
      }
      const body: any = {
        namespace: ing.namespace,
        host: ing.host,
        path: ing.path,
        backend: ing.backend,
        tls: useTLS,
      };
      if (useTLS) body.secretName = secret;
      await createIngress(cid, body);
      setIng({ namespace: "default", host: "", path: "/", backend: "my-svc:8080", tls: "true", secretName: "", certMode: "select", _svcKey: "" });
      setCertSecret("");
      setGenMsg("");
      setIngOpen(false);
      reloadAll();
    } catch (e: any) {
      setCreateErr(e?.message ?? String(e));
    }
  };

  const detailTitle =
    detailKind === "svc"
      ? `Service · ${detailSvc?.namespace ?? "..."}/${detailSvc?.name ?? "..."}`
      : detailKind === "ing"
        ? `Ingress · ${detailIng?.namespace ?? "..."}/${detailIng?.name ?? "..."}`
        : "";

  // 「指定工作负载」chip 颜色与标签（与 WorkloadPicker 内部使用同一份映射；详见 WorkloadPicker.tsx）
  const wlChipCls =
    linkedWorkload?.kind === "statefulset"
      ? "text-cyan-600 bg-cyan-100 border-cyan-200"
      : linkedWorkload?.kind === "daemonset"
        ? "text-warn bg-warn-bg border-warn"
        : "text-brand-600 bg-brand-50 border-brand-100";
  const wlChipLabel =
    linkedWorkload?.kind === "statefulset" ? "STS"
      : linkedWorkload?.kind === "daemonset" ? "DaemonSet"
        : "Deploy";

  return (
    <div className="top-aura relative p-5 space-y-4">
      {(errSvc || errIng) && <ErrorBanner msg={errSvc ?? errIng ?? ""} />}
      {(((services as any)._permDenied) || ((ingresses as any)._permDenied)) && (
        <ErrorBanner msg="当前账号无该集群的访问权限，暂无数据展示" title="无集群访问权限" hint="当前账号未被授权访问该集群，已清空展示数据。" />
      )}

      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {loadingAny ? (
          <>
            <div className="rise-1"><KpiSkeleton label="Service" icon={<NetIcon size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiSkeleton label="Ingress" icon={<Globe size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiSkeleton label="负载均衡器" icon={<Share2 size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiSkeleton label="对外暴露" icon={<ShieldCheck size={18} />} accent="warn" /></div>
          </>
        ) : (
          <>
            <div className="rise-1"><KpiStat label="Service" value={serviceCount} unit="个" icon={<NetIcon size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiStat label="Ingress" value={ingressCount} unit="个" icon={<Globe size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiStat label="负载均衡器" value={lbCount} unit="个" icon={<Share2 size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiStat label="对外暴露" value={exposedSvc} unit="个" icon={<ShieldCheck size={18} />} accent={exposedSvc > 0 ? "warn" : "ok"} /></div>
          </>
        )}
      </div>

      {/* Service / Ingress 顶部 Tab 切换（类似工作负载页 Deployment 等） */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex p-0.5 bg-sunken rounded-lg border border-line">
          <button
            onClick={() => setTab("svc")}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition",
              tab === "svc" ? "bg-surface text-brand-700 shadow-sh-1" : "text-ink-500 hover:text-ink-900",
            )}
          >
            <NetIcon size={14} /> Service
            <span className={cn("font-mono text-[10px] px-1.5 rounded", tab === "svc" ? "bg-brand-50 text-brand-600" : "bg-line text-ink-400")}>{serviceCount}</span>
          </button>
          <button
            onClick={() => setTab("ing")}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition",
              tab === "ing" ? "bg-surface text-brand-700 shadow-sh-1" : "text-ink-500 hover:text-ink-900",
            )}
          >
            <Globe size={14} /> Ingress
            <span className={cn("font-mono text-[10px] px-1.5 rounded", tab === "ing" ? "bg-brand-50 text-brand-600" : "bg-line text-ink-400")}>{ingressCount}</span>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 h-9 rounded-lg bg-sunken border border-line w-64 focus-within:border-brand-300 focus-within:bg-surface transition">
            <Search size={15} className="text-ink-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent outline-none text-[12.5px] w-full placeholder:text-ink-300"
              placeholder={tab === "svc" ? "按名称 / 命名空间筛选…" : "按域名 / 名称筛选…"}
            />
          </div>
          <PrimaryButton
            icon={<Plus size={15} />}
            onClick={() => {
              setCreateErr(null);
              if (tab === "svc") setSvcOpen(true);
              else setIngOpen(true);
            }}
          >
            {tab === "svc" ? "创建 Service" : "创建 Ingress"}
          </PrimaryButton>
        </div>
      </div>

      {/* 列表卡片（全宽 + 宽松排版） */}
      <Card>
        <div className="overflow-x-auto">
          {tab === "svc" ? (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-400 text-[10.5px] font-semibold uppercase tracking-wider">
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">名称</th>
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">命名空间</th>
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">类型</th>
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">ClusterIP</th>
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">端口</th>
                  <th className="text-right font-semibold px-4 py-3 bg-subtle border-b border-line">状态</th>
                  <th className="text-right font-semibold px-4 py-3 bg-subtle border-b border-line w-[150px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {loadingSvc ? (
                  <TableSkeleton rows={8} cols={7} />
                ) : !Array.isArray(services) || services.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-ink-400 text-[12.5px]">该集群暂无 Service</td></tr>
                ) : svcRows.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-ink-400 text-[12.5px]">未找到匹配的 Service</td></tr>
                ) : (
                  svcPage.slice(svcRows as any[]).map((s: any) => (
                    <tr key={`${s.namespace}/${s.name}`} className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer" onClick={() => openDetail("svc", s)}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <NetIcon size={14} className="text-brand-500 shrink-0" />
                          <span className="font-mono text-ink-900 truncate" title={s.name}>{s.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11.5px] text-ink-500 truncate" title={s.namespace}>{s.namespace}</td>
                      <td className="px-4 py-3">
                        <span className={cn("font-mono text-[11px] rounded px-2 py-1", s.type === "LoadBalancer" ? "text-cyan-600 bg-cyan-100" : s.type === "NodePort" ? "text-warn bg-warn-bg" : "text-ink-500 bg-sunken")}>{s.type}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11.5px] text-ink-500 truncate max-w-[170px]" title={s.clusterIP}>{s.clusterIP}</td>
                      <td className="px-4 py-3 font-mono text-[11.5px] text-ink-500 truncate max-w-[200px]" title={s.ports}>{s.ports}</td>
                      <td className="px-4 py-3 text-right"><StatusBadge kind={s.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-3 justify-end whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 text-[11.5px] text-brand-600"><FileText size={13} /> 详情</span>
                          <button onClick={(e) => { e.stopPropagation(); setPendingDelete({ kind: "svc", name: s.name, ns: s.namespace }); }} className="inline-flex items-center gap-1 text-[11.5px] text-err hover:bg-err/10 rounded px-1.5 py-0.5 transition" title="删除 Service">
                            <Trash2 size={13} /> 删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-400 text-[10.5px] font-semibold uppercase tracking-wider">
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">域名</th>
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">路径</th>
                  <th className="text-left font-semibold px-4 py-3 bg-subtle border-b border-line">后端服务</th>
                  <th className="text-right font-semibold px-4 py-3 bg-subtle border-b border-line">TLS</th>
                  <th className="text-right font-semibold px-4 py-3 bg-subtle border-b border-line">状态</th>
                  <th className="text-right font-semibold px-4 py-3 bg-subtle border-b border-line w-[150px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {loadingIng ? (
                  <TableSkeleton rows={8} cols={6} />
                ) : !Array.isArray(ingresses) || ingresses.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-400 text-[12.5px]">该集群暂无 Ingress</td></tr>
                ) : ingRows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-400 text-[12.5px]">未找到匹配的 Ingress</td></tr>
                ) : (
                  ingPage.slice(ingRows as any[]).map((g: any) => (
                    <tr key={g.name} className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer" onClick={() => openDetail("ing", g)}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Globe size={14} className="text-brand-500 shrink-0" />
                          <span className="font-mono text-ink-900 truncate max-w-[260px]" title={g.host}>{g.host || "—"}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11.5px] text-ink-500 truncate max-w-[160px]" title={g.path}>{g.path}</td>
                      <td className="px-4 py-3 font-mono text-[11.5px] text-ink-500 truncate max-w-[220px]" title={g.backend}>{g.backend}</td>
                      <td className="px-4 py-3 text-right">{g.tls ? <span className="text-[11.5px] font-medium text-ok bg-ok-bg rounded px-2 py-1">HTTPS</span> : <span className="text-[11.5px] font-medium text-ink-400 bg-sunken rounded px-2 py-1">HTTP</span>}</td>
                      <td className="px-4 py-3 text-right"><StatusBadge kind={g.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-3 justify-end whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 text-[11.5px] text-brand-600"><FileText size={13} /> 详情</span>
                          <button onClick={(e) => { e.stopPropagation(); setPendingDelete({ kind: "ing", name: g.name, ns: g.namespace }); }} className="inline-flex items-center gap-1 text-[11.5px] text-err hover:bg-err/10 rounded px-1.5 py-0.5 transition" title="删除 Ingress">
                            <Trash2 size={13} /> 删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        {!activeLoading && (
          <Pagination
            page={activePage.page}
            totalPages={activePage.totalPages}
            start={activePage.start}
            end={activePage.end}
            total={activeRows.length}
            pageSize={activePage.pageSize}
            onPageChange={activePage.setPage}
            onPageSizeChange={activePage.setPageSize}
          />
        )}
      </Card>

      {/* 网络策略概览（基于真实数据派生） */}
      <Card className="rise-4">
        <CardHead title="暴露概览" sub={`当前集群 Service 与 Ingress 的真实暴露情况 · 由 CoreDNS 提供集群内 DNS 解析`} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4">
          {[
            { t: "对外暴露 Service", d: `${exposedSvc} 个 (LB / NodePort)`, c: "warn" },
            { t: "Ingress 路由", d: `${ingressCount} 条`, c: "cyan" },
            { t: "集群 DNS", d: "CoreDNS", c: "ok" },
            { t: "默认命名空间", d: "default", c: "info" },
          ].map((p) => (
            <div key={p.t} className="rounded-lg border border-line bg-subtle p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`w-2 h-2 rounded-full ${p.c === "warn" ? "bg-warn" : p.c === "ok" ? "bg-ok" : p.c === "info" ? "bg-info" : "bg-brand-500"}`} />
                <span className="text-[12.5px] font-medium text-ink-900">{p.t}</span>
              </div>
              <div className="font-mono text-[10.5px] text-ink-400">{p.d}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* 创建 Service 弹窗 */}
      <Modal
        open={svcOpen}
        onClose={() => setSvcOpen(false)}
        title="创建 Service"
        desc="暴露工作负载的访问入口"
        icon={<NetIcon size={15} />}
        maxW="max-w-2xl"
        footer={
          <>
            <button onClick={() => setSvcOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={createSvc} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
          </>
        }
      >
        {createErr && <div className="mb-3"><ErrorBanner msg={createErr} /></div>}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称"><TextInput value={svc.name} onChange={updSvc("name")} placeholder="my-svc" /></Field>
            <Field label="命名空间">
              <SelectInput value={svc.namespace || "default"} onChange={updSvc("namespace")}>
                {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
              </SelectInput>
            </Field>
            <Field label="类型"><SelectInput value={svc.type} onChange={updSvc("type")}><option>ClusterIP</option><option>NodePort</option><option>LoadBalancer</option></SelectInput></Field>
          </div>
          <Field
            label="端口映射"
            hint="服务端口 = Service 暴露的访问端口；容器端口 = Pod 内部实际监听的端口（二者可不同）；可添加多个端口"
          >
            <PortEditor value={svc.ports} onChange={(v) => setSvc((s) => ({ ...s, ports: v }))} />
          </Field>

          {/* 「指定工作负载」—— 通过选定集群中已有的 Deployment/STS/DS 自动填入 selector；
              与下方手动键/值「标签选择器」并列存在，二者可同时使用，键冲突时手动值优先。 */}
          <div className="rounded-lg border border-line bg-subtle/50 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <Layers size={13} className="text-brand-500" />
                <span className="text-[12px] font-medium text-ink-900">指定工作负载</span>
                <span className="font-mono text-[10px] text-ink-400">（可选）</span>
              </div>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-brand-200 bg-surface text-[11.5px] text-brand-700 hover:bg-brand-50 hover:border-brand-300 transition"
              >
                {linkedWorkload ? "重新选择" : "+ 从工作负载同步"}
              </button>
            </div>
            {linkedWorkload ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("inline-flex items-center gap-1 font-mono text-[10.5px] rounded px-1.5 py-0.5 border", wlChipCls)}>
                  {wlChipLabel}
                </span>
                <span className="font-mono text-[12px] text-ink-900 truncate" title={`${linkedWorkload.namespace}/${linkedWorkload.name}`}>
                  {linkedWorkload.namespace}/{linkedWorkload.name}
                </span>
                <span className="text-[10.5px] text-ink-400">
                  · {Object.keys(linkedWorkload.labels || {}).length} 个 label 已同步到 selector
                  {(linkedWorkload.containerPorts || []).length > 0 && (
                    <> · {(linkedWorkload.containerPorts || []).length} 个容器端口已同步到端口映射</>
                  )}
                </span>
                <button
                  type="button"
                  onClick={clearLinkedWorkload}
                  className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-err hover:bg-err/10 rounded px-1.5 py-0.5 transition"
                  title="移除关联（不会回滚 selector 已填内容）"
                >
                  移除
                </button>
              </div>
            ) : (
              <div className="text-[11.5px] text-ink-400 italic">
                未指定 — 选择一个工作负载后会自动把它的 labels 填到下方「标签选择器」，可直接在文本框继续编辑
              </div>
            )}
          </div>

          {/* 工作负载选择器（手动键值对，与「指定工作负载」联动） */}
          <Field
            label="工作负载选择器"
            hint="格式：key=value，多个用英文逗号分隔；如已指定工作负载，上方 labels 已自动填入此处，可继续手动增删"
          >
            <TextInput
              value={svc.selector}
              onChange={updSvc("selector")}
              placeholder="app=myapp,tier=backend"
            />
          </Field>
        </div>
      </Modal>

      {/* 创建 Ingress 弹窗 */}
      <Modal
        open={ingOpen}
        onClose={() => setIngOpen(false)}
        title="创建 Ingress"
        desc="七层路由与 TLS"
        maxW="max-w-xl"
        icon={<Globe size={15} />}
        footer={
          <>
            <button onClick={() => setIngOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={createIng} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
          </>
        }
      >
        {createErr && <div className="mb-3"><ErrorBanner msg={createErr} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="命名空间" className="col-span-2">
            <SelectInput value={ing.namespace || "default"} onChange={updIng("namespace")}>
              {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
            </SelectInput>
          </Field>
          <Field label="域名" className="col-span-2"><TextInput value={ing.host} onChange={updIng("host")} placeholder="app.example.com" /></Field>
          <Field label="路径"><TextInput value={ing.path} onChange={updIng("path")} placeholder="/" /></Field>
          <Field label="后端服务">
            {serviceList.length > 0 ? (
              <SearchSelect
                value={(ing as any)._svcKey ?? ""}
                onChange={onPickService}
                options={serviceList.map((s: any) => ({
                  value: `${s.namespace}/${s.name}`,
                  label: `${s.namespace}/${s.name}`,
                  sub: s.type,
                }))}
                placeholder="选择服务（可搜索）"
                searchPlaceholder="按命名空间/名称搜索…"
                emptyText="无匹配服务"
              />
            ) : (
              <TextInput value={ing.backend} onChange={updIng("backend")} placeholder="my-svc:8080" />
            )}
          </Field>
          {serviceList.length > 0 && (
            <Field label="服务端口">
              <SelectInput value={ing.backend.split(":")[1] ?? ""} onChange={(e) => onPickPort(e.target.value)}>
                {svcPorts.length > 0 ? (
                  svcPorts.map((p) => <option key={p} value={p}>{p}</option>)
                ) : (
                  <option value="">—</option>
                )}
              </SelectInput>
            </Field>
          )}
          <Field label="TLS" className="col-span-2"><SelectInput value={ing.tls} onChange={updIng("tls")}><option value="true">启用 HTTPS</option><option value="false">仅 HTTP</option></SelectInput></Field>

          {/* TLS 证书来源（仅启用 HTTPS 时显示） */}
          {ing.tls === "true" && (
            <div className="col-span-2 rounded-lg border border-line bg-sunken/40 p-3 space-y-3">
              <div className="text-[12px] font-medium text-ink-700">TLS 证书来源</div>
              <div className="flex items-center gap-4 text-[12px]">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="certMode" checked={ing.certMode === "select"} onChange={() => setIng((s) => ({ ...s, certMode: "select" }))} />
                  从代码凭证选择
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="certMode" checked={ing.certMode === "generate"} onChange={() => setIng((s) => ({ ...s, certMode: "generate" }))} />
                  随机生成（自签名）
                </label>
              </div>

              {ing.certMode === "select" && (
                <Field label="选择 TLS 凭证">
                  <SelectInput
                    value={certSecret ? `secret/${certSecret}` : ""}
                    onChange={(e) => setCertSecret(e.target.value.replace(/^secret\//, ""))}
                  >
                    <option value="">— 选择凭证 —</option>
                    {tlsCredentials.map((c: any) => (
                      <option key={c.name} value={c.secretRef}>{c.name} ({c.secretRef})</option>
                    ))}
                  </SelectInput>
                </Field>
              )}

              {ing.certMode === "generate" && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={generateCert}
                    disabled={genLoading}
                    className={cn(
                      "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-white text-[12.5px] font-medium whitespace-nowrap shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] transition",
                      genLoading
                        ? "bg-sunken text-ink-400 cursor-not-allowed"
                        : "bg-gradient-to-r from-brand-600 to-cyan-500 hover:opacity-95 hover:shadow-[0_4px_14px_-2px_rgba(19,96,196,.55)] active:translate-y-px",
                    )}
                  >
                    {genLoading ? <><RefreshCw size={13} className="inline animate-spin mr-1" />生成中…</> : "生成证书并同步到凭证库"}
                  </button>
                  {!ing.host && <div className="text-[11.5px] text-ink-400">需先在上方填写「域名」才能生成证书</div>}
                  {genMsg && <div className="text-[11.5px] text-ok">{genMsg}</div>}
                  {certSecret && <div className="text-[11.5px] text-ink-500 font-mono">secret/{certSecret}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* 详情 + 编辑 弹窗 */}
      <Modal
        open={detailKind !== null}
        onClose={closeDetail}
        title={detailTitle}
        desc="K8s 资源详情 · 可编辑字段随 K8s 规范"
        icon={detailKind === "svc" ? <NetIcon size={15} /> : <Globe size={15} />}
        footer={
          detailKind ? (
            editMode ? (
              <>
                <button onClick={() => setEditMode(false)} disabled={editSaving} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition disabled:opacity-50">取消</button>
                <button onClick={saveEdit} disabled={editSaving} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50">
                  {editSaving ? <><RefreshCw size={13} className="inline animate-spin mr-1" />保存中…</> : "保存"}
                </button>
              </>
            ) : (
              <>
                <button onClick={onDeleteFromDetail} className="h-9 px-3 rounded-lg border border-err text-err text-[12.5px] font-medium hover:bg-err/10 transition">
                  <Trash2 size={13} className="inline mr-1" />删除
                </button>
                <button onClick={() => setEditMode(true)} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">
                  <Pencil size={13} className="inline mr-1" />编辑
                </button>
              </>
            )
          ) : <></>
        }
      >
        {detailLoading ? (
          <div className="flex items-center gap-2 text-ink-400 text-[12px] py-6"><RefreshCw size={14} className="animate-spin" /> 加载详情…</div>
        ) : detailErr ? (
          <ErrorBanner msg={detailErr} />
        ) : (
          <div className="space-y-4">
            {detailKind === "svc" && detailSvc && (
              <>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <Info label="名称" value={detailSvc.name} mono />
                  <Info label="命名空间" value={detailSvc.namespace} mono />
                  <Info label="类型" value={detailSvc.type} />
                  <Info label="ClusterIP" value={detailSvc.clusterIP} mono />
                  <Info label="端口" value={detailSvc.ports} mono />
                  <Info label="状态" value={detailSvc.status} />
                </div>
                {editMode ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="类型">
                        <SelectInput value={editSvcType} onChange={(e) => setEditSvcType(e.target.value)}>
                          <option>ClusterIP</option>
                          <option>NodePort</option>
                          <option>LoadBalancer</option>
                        </SelectInput>
                      </Field>
                    </div>
                    <Field
                      label="端口映射"
                      hint="服务端口 = Service 暴露的访问端口；容器端口 = Pod 内部实际监听的端口（二者可不同）；可添加多个端口"
                    >
                      <PortEditor value={editSvcPorts} onChange={setEditSvcPorts} />
                    </Field>
                    <Field label="标签选择器（key=value，逗号分隔）">
                      <TextInput value={editSvcSelector} onChange={(e) => setEditSvcSelector(e.target.value)} placeholder="app=myapp" />
                    </Field>
                    <Field label="Annotations（key=value，每行一条）" hint="保存时与原值合并（已存在的 key 被替换）">
                      <textarea value={editSvcAnnot} onChange={(e) => setEditSvcAnnot(e.target.value)} rows={5} className="w-full font-mono text-[11.5px] bg-sunken border border-line rounded-md px-3 py-2 focus:outline-none focus:border-brand-500" />
                    </Field>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">标签选择器</div>
                      <div className="font-mono text-[11px] bg-sunken border border-line rounded-md p-2">{detailSvc.selector || "（无）"}</div>
                    </div>
                    <div>
                      <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">Annotations</div>
                      <div className="font-mono text-[11px] bg-sunken border border-line rounded-md p-2 max-h-32 overflow-y-auto">{detailSvc.annotations || "（无）"}</div>
                    </div>
                  </div>
                )}
              </>
            )}

            {detailKind === "ing" && detailIng && (
              <>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <Info label="名称" value={detailIng.name} mono />
                  <Info label="命名空间" value={detailIng.namespace} mono />
                  <Info label="域名" value={detailIng.host} mono />
                  <Info label="路径" value={detailIng.path} mono />
                  <Info label="后端服务" value={detailIng.backend} mono />
                  <Info label="TLS" value={detailIng.tls ? "HTTPS" : "HTTP"} />
                </div>
                {editMode && (
                  <div className="space-y-3">
                    <Field label="路径"><TextInput value={editIngPath} onChange={(e) => setEditIngPath(e.target.value)} placeholder="/" /></Field>
                    <Field label="后端服务"><TextInput value={editIngBackend} onChange={(e) => setEditIngBackend(e.target.value)} placeholder="my-svc:8080" /></Field>
                    <Field label="TLS"><SelectInput value={editIngTls} onChange={(e) => setEditIngTls(e.target.value)}><option value="true">启用 HTTPS</option><option value="false">仅 HTTP</option></SelectInput></Field>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>

      {/* 删除二次确认 */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => { if (!deleting) setPendingDelete(null); }}
        title="确认删除"
        desc="该操作将直接从真实集群移除资源"
        icon={<Trash2 size={15} className="text-err" />}
        footer={
          <>
            <button onClick={() => !deleting && setPendingDelete(null)} disabled={deleting} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition disabled:opacity-50">取消</button>
            <button onClick={confirmDelete} disabled={deleting} className="h-9 px-3.5 rounded-lg bg-err text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(220,38,38,.45)] hover:opacity-95 transition disabled:opacity-50">
              {deleting ? <><RefreshCw size={13} className="inline animate-spin mr-1" />删除中…</> : "删除"}
            </button>
          </>
        }
      >
        {deleteErr && <div className="mb-3"><ErrorBanner msg={deleteErr} /></div>}
        {pendingDelete && (
          <div className="text-[12.5px] text-ink-700 leading-relaxed">
            确定要删除
            <span className="mx-1 font-mono text-ink-900">{pendingDelete.kind === "svc" ? "Service" : "Ingress"}</span>
            <span className="font-mono text-err break-all">{pendingDelete.ns}/{pendingDelete.name}</span>
            <span className="text-ink-400"> 吗？此操作不可恢复，资源将从集群中直接移除。</span>
          </div>
        )}
      </Modal>

      {/* 「从工作负载同步」二级弹窗（用于 Service Selector 自动填入） */}
      <WorkloadPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={onPickWorkload}
      />
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[10px] text-ink-400 mb-0.5">{label}</div>
      <div className={`${mono ? "font-mono" : ""} text-[12px] text-ink-800 truncate`} title={value}>{value}</div>
    </div>
  );
}

// 结构化端口编辑器：每行 = 服务端口 + 容器内部端口 + 协议，可增删多端口
function PortEditor({ value, onChange }: { value: ServicePortInput[]; onChange: (v: ServicePortInput[]) => void }) {
  const setAt = (i: number, patch: Partial<ServicePortInput>) =>
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { port: 80, targetPort: 80, protocol: "TCP" }]);
  const inputCls =
    "w-full font-mono text-[12px] bg-sunken border border-line rounded-md px-2.5 py-2 focus:outline-none focus:border-brand-500 focus:bg-surface transition";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-ink-400 font-semibold">
        <span className="flex-1">服务端口</span>
        <span className="flex-1">容器端口（内部）</span>
        <span className="w-[92px]">协议</span>
        <span className="w-7" />
      </div>
      {value.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={p.port || ""}
            onChange={(e) => setAt(i, { port: parseInt(e.target.value, 10) })}
            className={inputCls}
            placeholder="8080"
          />
          <input
            type="number"
            min={1}
            value={p.targetPort ?? p.port ?? ""}
            onChange={(e) => setAt(i, { targetPort: parseInt(e.target.value, 10) })}
            className={inputCls}
            placeholder="8080"
          />
          <select
            value={p.protocol || "TCP"}
            onChange={(e) => setAt(i, { protocol: e.target.value })}
            className={`${inputCls} w-[92px] cursor-pointer`}
          >
            <option>TCP</option>
            <option>UDP</option>
            <option>SCTP</option>
          </select>
          <button
            type="button"
            onClick={() => removeAt(i)}
            disabled={value.length <= 1}
            className="w-7 h-9 inline-flex items-center justify-center rounded-md border border-line text-ink-400 hover:text-err hover:border-err/40 hover:bg-err/10 transition disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-line disabled:hover:text-ink-400"
            title="删除该端口"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-dashed border-brand-200 text-[11.5px] text-brand-700 hover:bg-brand-50 transition"
      >
        <Plus size={13} /> 添加端口
      </button>
    </div>
  );
}
