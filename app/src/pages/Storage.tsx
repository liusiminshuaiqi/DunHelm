import { useState } from "react";
import { Card, CardHead, KpiStat, StatusBadge, Modal, Field, TextInput, SelectInput, PrimaryButton, ErrorBanner, TableSkeleton, KpiSkeleton, usePagination, Pagination } from "@/components/ui/primitives";
import { useStorageClasses, usePVCs, usePVs, useStorageSummary, useNamespaces } from "@/data/useLive";
import {
  storageClassDetail,
  pvDetail,
  pvcDetail,
  updateStorageClass,
  updatePV,
  updatePVC,
  createStorageClass,
  createPVC,
  createPV,
  deleteStorageClass,
  deletePV,
  deletePVC,
  type StorageClassDetailResp,
  type PVDetailResp,
  type PVCDetailResp,
  type PVCreateInput,
} from "@/lib/api";
import { getCluster } from "@/lib/cluster";
import { Database, HardDrive, Layers, Link2, Plus, RefreshCw, FileText, Pencil, Trash2 } from "lucide-react";

function CapBar({ v }: { v: number }) {
  const c = v >= 90 ? "bg-err" : v >= 75 ? "bg-warn" : "bg-gradient-to-r from-brand-600 to-cyan-500";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="w-20 h-[7px] rounded-full bg-sunken overflow-hidden">
        <span className={`block h-full rounded-full ${c}`} style={{ width: `${v}%` }} />
      </span>
      <span className="font-mono text-[11.5px] text-ink-500 tabular-nums">{v}%</span>
    </span>
  );
}

function fmtBytes(b: number): string {
  if (!b || b <= 0) return "0";
  const GiB = 1024 * 1024 * 1024;
  const TiB = 1024 * GiB;
  if (b >= TiB) return `${(b / TiB).toFixed(1)}TiB`;
  if (b >= GiB) return `${(b / GiB).toFixed(1)}GiB`;
  return `${Math.round(b / (1024 * 1024))}MiB`;
}

export function Storage() {
  const liveSc = useStorageClasses();
  const livePvc = usePVCs();
  const livePv = usePVs();
  const { data: summary, reload: reloadSummary } = useStorageSummary();
  const namespaces = useNamespaces();
  const storageClasses = liveSc as any;
  const pvcs = livePvc as any;
  const pvs = livePv as any;
  const loadingSc = storageClasses._loading === true;
  const loadingPvc = pvcs._loading === true;
  const loadingPv = pvs._loading === true;
  const errSc = (storageClasses as any)._error as string | undefined;
  const errPvc = (pvcs as any)._error as string | undefined;
  const errPv = (pvs as any)._error as string | undefined;
  const reloadSc: () => void = (storageClasses as any).reload ?? (() => {});
  const reloadPvc: () => void = (pvcs as any).reload ?? (() => {});
  const reloadPv: () => void = (pvs as any).reload ?? (() => {});

  const totalPV = summary?.pvCount ?? pvs.length;
  const [scOpen, setScOpen] = useState(false);
  const [pvcOpen, setPvcOpen] = useState(false);
  const [pvOpen, setPvOpen] = useState(false);
  const [sc, setSc] = useState({ name: "", provisioner: "openebs.io/local", reclaim: "Delete", bindMode: "Immediate" });
  const [pvc, setPvc] = useState({ name: "", namespace: "default", storageClass: "", capacity: "10Gi", access: "RWO" });
  const [pv, setPv] = useState({
    name: "",
    capacity: "10Gi",
    accessModes: "RWO",
    storageClass: "",
    reclaimPolicy: "Delete",
    sourceType: "hostPath",
    sourceHostPath: "/data/pv-demo",
    sourceNFSServer: "",
    sourceNFSPath: "",
    sourceLocalPath: "",
    sourceLocalNode: "",
    sourceCSIDriver: "",
    sourceCSIVolumeHandle: "",
    sourceCSIFSType: "",
  });
  const updSc = (k: keyof typeof sc) => (e: { target: { value: string } }) => setSc((s) => ({ ...s, [k]: e.target.value }));
  const updPvc = (k: keyof typeof pvc) => (e: { target: { value: string } }) => setPvc((s) => ({ ...s, [k]: e.target.value }));
  const updPv = (k: keyof typeof pv) => (e: { target: { value: string } }) => setPv((s) => ({ ...s, [k]: e.target.value }));
  // 创建失败（含未选集群）的提示，展示在对应弹窗内
  const [createErr, setCreateErr] = useState<string | null>(null);

  // 详情/编辑弹窗状态
  const [detailKind, setDetailKind] = useState<"sc" | "pv" | "pvc" | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [scDetail, setScDetail] = useState<StorageClassDetailResp | null>(null);
  const [pvDetailInfo, setPvDetailInfo] = useState<PVDetailResp | null>(null);
  const [pvcDetailInfo, setPvcDetailInfo] = useState<PVCDetailResp | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  // edit form
  const [editScAnnot, setEditScAnnot] = useState("");
  const [editScParams, setEditScParams] = useState("");
  const [editPvReclaimPolicy, setEditPvReclaimPolicy] = useState("Delete");
  const [editPvAnnot, setEditPvAnnot] = useState("");
  const [editPvcCapacity, setEditPvcCapacity] = useState("");

  const reloadAll = () => { reloadSc(); reloadPvc(); reloadPv(); reloadSummary(); };

  // 删除（SC / PV / PVC）状态 + 二次确认
  const [pendingDelete, setPendingDelete] = useState<{ kind: "sc" | "pv" | "pvc"; name: string; ns?: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

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
      if (pd.kind === "sc") await deleteStorageClass(cid, pd.name);
      else if (pd.kind === "pv") await deletePV(cid, pd.name);
      else await deletePVC(cid, pd.ns ?? "default", pd.name);
      setPendingDelete(null);
      reloadAll();
    } catch (e: any) {
      setDeleteErr(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  };

  const openDetail = async (kind: "sc" | "pv" | "pvc", name: string, ns?: string) => {
    const cid = getCluster();
    if (!cid) return;
    setDetailKind(kind);
    setDetailLoading(true);
    setDetailErr(null);
    setEditMode(false);
    try {
      if (kind === "sc") {
        const d = await storageClassDetail(cid, name);
        setScDetail(d);
        setEditScAnnot(Object.entries(d.annotations ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
        setEditScParams(Object.entries(d.parameters ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
      } else if (kind === "pv") {
        const d = await pvDetail(cid, name);
        setPvDetailInfo(d);
        setEditPvReclaimPolicy(d.persistentVolume.reclaimPolicy || "Delete");
        setEditPvAnnot(Object.entries(d.persistentVolume.annotations ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
      } else {
        const d = await pvcDetail(cid, ns!, name);
        setPvcDetailInfo(d);
        setEditPvcCapacity(d.pvc.capacity || "");
      }
    } catch (e: any) {
      setDetailErr(e?.message ?? String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetailKind(null);
    setScDetail(null);
    setPvDetailInfo(null);
    setPvcDetailInfo(null);
    setDetailErr(null);
    setEditMode(false);
  };

  // 详情弹窗里的「删除」按钮：取出当前对象名并设置待确认状态，然后关闭详情弹窗
  const onDeleteFromDetail = () => {
    const kind = detailKind;
    if (!kind) return;
    let name = "";
    let ns: string | undefined;
    if (kind === "sc") name = scDetail?.storageClass.name ?? "";
    else if (kind === "pv") name = pvDetailInfo?.persistentVolume.name ?? "";
    else {
      name = pvcDetailInfo?.pvc.name ?? "";
      ns = pvcDetailInfo?.pvc.namespace;
    }
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

  const saveEdit = async () => {
    const cid = getCluster();
    if (!cid) return;
    setEditSaving(true);
    setDetailErr(null);
    try {
      if (detailKind === "sc" && scDetail) {
        const d = await updateStorageClass(cid, scDetail.storageClass.name, {
          parameters: parseKeyValue(editScParams),
          annotations: parseKeyValue(editScAnnot),
        });
        setScDetail(d);
      } else if (detailKind === "pv" && pvDetailInfo) {
        const d = await updatePV(cid, pvDetailInfo.persistentVolume.name, {
          reclaimPolicy: editPvReclaimPolicy,
          annotations: parseKeyValue(editPvAnnot),
        });
        setPvDetailInfo(d);
      } else if (detailKind === "pvc" && pvcDetailInfo) {
        const d = await updatePVC(cid, pvcDetailInfo.pvc.namespace, pvcDetailInfo.pvc.name, {
          capacity: editPvcCapacity,
        });
        setPvcDetailInfo(d);
      }
      setEditMode(false);
      reloadAll();
    } catch (e: any) {
      setDetailErr(e?.message ?? String(e));
    } finally {
      setEditSaving(false);
    }
  };

  const createSc = async () => {
    if (!sc.name) return;
    setCreateErr(null);
    try {
      const cid = getCluster();
      if (!cid) {
        setCreateErr("请先选择集群（StorageClass 为 cluster-scoped 资源，需在真实集群创建）");
        return;
      }
      await createStorageClass(cid, { ...sc });
      setSc({ name: "", provisioner: "openebs.io/local", reclaim: "Delete", bindMode: "Immediate" });
      setScOpen(false);
      reloadAll();
    } catch (e: any) {
      setCreateErr(e?.message ?? String(e));
    }
  };

  const createPvc = async () => {
    if (!pvc.name) return;
    setCreateErr(null);
    try {
      const cid = getCluster();
      if (!cid) {
        setCreateErr("请先选择集群（PVC 需在真实集群创建）");
        return;
      }
      await createPVC(cid, { ...pvc });
      setPvc({ name: "", namespace: "default", storageClass: "", capacity: "10Gi", access: "RWO" });
      setPvcOpen(false);
      reloadAll();
    } catch (e: any) {
      setCreateErr(e?.message ?? String(e));
    }
  };

  const createPv = async () => {
    if (!pv.name) return;
    setCreateErr(null);
    try {
      const cid = getCluster();
      if (!cid) {
        setCreateErr("请先选择集群（PersistentVolume 为 cluster-scoped 资源，需在真实集群创建）");
        return;
      }
      const body: PVCreateInput = {
        name: pv.name,
        capacity: pv.capacity,
        accessModes: pv.accessModes.split(",").map((s) => s.trim()).filter(Boolean),
        storageClass: pv.storageClass,
        reclaimPolicy: pv.reclaimPolicy,
        sourceType: pv.sourceType,
        sourceHostPath: pv.sourceHostPath,
        sourceNFSServer: pv.sourceNFSServer,
        sourceNFSPath: pv.sourceNFSPath,
        sourceLocalPath: pv.sourceLocalPath,
        sourceLocalNode: pv.sourceLocalNode,
        sourceCSIDriver: pv.sourceCSIDriver,
        sourceCSIVolumeHandle: pv.sourceCSIVolumeHandle,
        sourceCSIFSType: pv.sourceCSIFSType,
      };
      await createPV(cid, body);
      setPv({
        name: "",
        capacity: "10Gi",
        accessModes: "RWO",
        storageClass: "",
        reclaimPolicy: "Delete",
        sourceType: "hostPath",
        sourceHostPath: "/data/pv-demo",
        sourceNFSServer: "",
        sourceNFSPath: "",
        sourceLocalPath: "",
        sourceLocalNode: "",
        sourceCSIDriver: "",
        sourceCSIVolumeHandle: "",
        sourceCSIFSType: "",
      });
      setPvOpen(false);
      reloadAll();
    } catch (e: any) {
      setCreateErr(e?.message ?? String(e));
    }
  };

  // 「按命名空间持久卷」Top 5：汇总真实 PVC 数据
  const byNs = (() => {
    const map = new Map<string, { count: number; capBytes: number }>();
    for (const p of pvcs) {
      const cap = p.capacity && p.capacity !== "—" ? p.capacity : "0";
      const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi)/i.exec(cap);
      let bytes = 0;
      if (m) {
        const n = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        const mult = unit === "KI" ? 1024 : unit === "MI" ? 1024 ** 2 : unit === "GI" ? 1024 ** 3 : unit === "TI" ? 1024 ** 4 : 1;
        bytes = n * mult;
      }
      const cur = map.get(p.namespace) ?? { count: 0, capBytes: 0 };
      cur.count++;
      cur.capBytes += bytes;
      map.set(p.namespace, cur);
    }
    const arr = [...map.entries()].sort((a, b) => b[1].capBytes - a[1].capBytes).slice(0, 5);
    const max = Math.max(1, ...arr.map(([, v]) => v.capBytes));
    return arr.map(([ns, v]) => ({ ns, count: v.count, cap: fmtBytes(v.capBytes), pct: Math.round((v.capBytes / max) * 100) }));
  })();
  const totalNsCount = new Set(pvcs.map((p: any) => p.namespace)).size;
  const loadingAny = loadingSc || loadingPvc || loadingPv;

  // 分页
  const scPage = usePagination(Array.isArray(storageClasses) ? storageClasses.length : 0);
  const pvPage = usePagination(Array.isArray(pvs) ? pvs.length : 0);
  const pvcPage = usePagination(Array.isArray(pvcs) ? pvcs.length : 0);
  const pageSc = scPage.slice(storageClasses as any[]);
  const pagePvs = pvPage.slice(pvs as any[]);
  const pagePvcs = pvcPage.slice(pvcs as any[]);

  // 详情弹窗标题 + 当前 key/对象
  const detailTitle = detailKind === "sc"
    ? `StorageClass · ${scDetail?.storageClass.name ?? "..."}`
    : detailKind === "pv"
      ? `PersistentVolume · ${pvDetailInfo?.persistentVolume.name ?? "..."}`
      : detailKind === "pvc"
        ? `PersistentVolumeClaim · ${pvcDetailInfo?.pvc.namespace ?? "..."}/${pvcDetailInfo?.pvc.name ?? "..."}`
        : "";

  return (
    <div className="top-aura relative p-5 space-y-4">
      {(errSc || errPvc || errPv) && (
        <ErrorBanner msg={errSc ?? errPvc ?? errPv ?? ""} />
      )}
      {(((storageClasses as any)._permDenied) || ((pvcs as any)._permDenied) || ((pvs as any)._permDenied)) && (
        <ErrorBanner msg="当前账号无该集群的访问权限，暂无数据展示" title="无集群访问权限" hint="当前账号未被授权访问该集群，已清空展示数据。" />
      )}

      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {summary ? (
          <>
            <div className="rise-1"><KpiStat label="存储类" value={summary.storageClassCount} unit="个" icon={<Layers size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiStat label="持久卷 (PV)" value={summary.pvCount} unit="个" icon={<HardDrive size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiStat label="总容量" value={fmtBytes(summary.totalCapacityBytes)} unit="" icon={<Database size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiStat label="绑定率" value={summary.bindRate} unit="%" icon={<Link2 size={18} />} accent={summary.bindRate === 100 ? "ok" : "warn"} /></div>
          </>
        ) : loadingAny ? (
          <>
            <div className="rise-1"><KpiSkeleton label="存储类" icon={<Layers size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiSkeleton label="持久卷 (PV)" icon={<HardDrive size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiSkeleton label="总容量" icon={<Database size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiSkeleton label="绑定率" icon={<Link2 size={18} />} accent="warn" /></div>
          </>
        ) : (
          <>
            <div className="rise-1"><KpiStat label="存储类" value={storageClasses.length} unit="个" icon={<Layers size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiStat label="持久卷 (PV)" value={pvs.length} unit="个" icon={<HardDrive size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiStat label="已用容量" value="—" unit="" icon={<Database size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiStat label="绑定率" value="—" unit="" icon={<Link2 size={18} />} accent="warn" /></div>
          </>
        )}
      </div>

      {/* 存储类 + 容量概览 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2 rise-2">
          <CardHead
            title="存储类"
            sub={summary ? `StorageClass · ${summary.defaultStorageClass ? `默认 ${summary.defaultStorageClass} · ` : ""}实时来自真实集群` : "StorageClass · 置备器与回收策略"}
            right={
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { reloadSc(); reloadSummary(); }}
                  disabled={loadingSc}
                  className="h-8 px-2.5 rounded-lg border border-line bg-surface text-[11.5px] text-ink-700 flex items-center gap-1.5 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw size={12} className={loadingSc ? "animate-spin" : ""} /> 刷新
                </button>
                <PrimaryButton icon={<Plus size={15} />} onClick={() => { setCreateErr(null); setScOpen(true); }}>新建存储类</PrimaryButton>
              </div>
            }
          />
          <div className="px-2 pb-2 overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-[12px] whitespace-nowrap">
              <colgroup>
                <col className="w-[22%]" /><col className="w-[24%]" /><col className="w-[12%]" /><col className="w-[20%]" /><col className="w-[10%]" /><col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr className="text-ink-400 text-[11px] font-medium">
                  <th className="text-left font-medium px-2.5 py-2">名称</th>
                  <th className="text-left font-medium px-2.5 py-2">置备器</th>
                  <th className="text-left font-medium px-2.5 py-2">回收</th>
                  <th className="text-left font-medium px-2.5 py-2">绑定模式</th>
                  <th className="text-right font-medium px-2.5 py-2">卷数</th>
                  <th className="text-right font-medium px-2.5 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {loadingSc ? (
                  <TableSkeleton rows={3} cols={6} />
                ) : !Array.isArray(storageClasses) || storageClasses.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-ink-400 text-[12px]">该集群暂无 StorageClass</td></tr>
                ) : pageSc.map((c: any) => (
                  <tr key={c.name} className="border-t border-line hover:bg-subtle transition cursor-pointer" onClick={() => openDetail("sc", c.name)}>
                    <td className="px-2.5 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-ink-900 truncate" title={c.name}>{c.name}</span>
                        {c.isDefault && <span className="text-[9px] font-mono text-brand-600 bg-brand-50 border border-brand-100 rounded px-1 shrink-0">default</span>}
                      </div>
                    </td>
                    <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={c.provisioner}>{c.provisioner}</td>
                    <td className="px-2.5 py-2"><StatusBadge kind={c.reclaim === "Retain" ? "warn" : "ok"} label={c.reclaim} /></td>
                    <td className="px-2.5 py-2 text-ink-500 truncate">{c.bindMode === "Immediate" ? "立即" : c.bindMode === "WaitForFirstConsumer" ? "首次消费" : c.bindMode}</td>
                  <td className="px-2.5 py-2 text-right font-mono text-ink-700 tabular-nums">{c.volumes ?? 0}</td>
                  <td className="px-2.5 py-2 text-right">
                    <div className="inline-flex items-center gap-2 justify-end whitespace-nowrap">
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-brand-600"><FileText size={11} /> 详情</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingDelete({ kind: "sc", name: c.name }); }}
                        className="inline-flex items-center gap-1 text-[10.5px] text-err hover:bg-err/10 rounded px-1 py-0.5 transition"
                        title="删除存储类"
                      ><Trash2 size={11} /> 删除</button>
                    </div>
                  </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loadingSc && (
            <Pagination page={scPage.page} totalPages={scPage.totalPages} start={scPage.start} end={scPage.end} total={Array.isArray(storageClasses) ? storageClasses.length : 0} pageSize={scPage.pageSize} onPageChange={scPage.setPage} onPageSizeChange={scPage.setPageSize} />
          )}
        </Card>

        <Card className="rise-3">
          <CardHead title="容量占用 Top" sub={summary ? "按命名空间持久卷请求容量" : "按命名空间持久卷"} />
          <div className="px-4 pb-4 space-y-3">
            {loadingPvc ? (
              <div className="text-[11.5px] text-ink-400">加载中…</div>
            ) : byNs.length === 0 ? (
              <div className="text-[11.5px] text-ink-400">{pvcs.length === 0 ? "该集群暂无 PVC" : "暂无数据"}</div>
            ) : byNs.map((row) => (
              <div key={row.ns}>
                <div className="flex items-center justify-between text-[11.5px] mb-1">
                  <span className="font-mono text-ink-700 truncate" title={row.ns}>{row.ns}</span>
                  <span className="text-ink-400 font-mono shrink-0 ml-2">{row.cap} · {row.count} 个</span>
                </div>
                <CapBar v={row.pct} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* PV 表格（cluster-scoped 资源）*/}
      <Card className="rise-3">
        <CardHead
          title="持久卷 (PV)"
          sub={summary ? `${summary.pvCount} 个 PV · cluster-scoped 资源` : `${totalPV} 个 PV`}
          right={
            <div className="flex items-center gap-2">
              <button onClick={reloadPv} disabled={loadingPv} className="h-8 px-2.5 rounded-lg border border-line bg-surface text-[11.5px] text-ink-700 flex items-center gap-1.5 hover:border-brand-300 hover:text-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
                <RefreshCw size={12} className={loadingPv ? "animate-spin" : ""} /> 刷新
              </button>
              <PrimaryButton icon={<Plus size={15} />} onClick={() => { setCreateErr(null); setPvOpen(true); }}>新建 PV</PrimaryButton>
            </div>
          }
        />
        <div className="px-2 pb-2 overflow-x-auto">
          <table className="w-full table-fixed text-[12px] whitespace-nowrap">
            <colgroup>
              <col className="w-[16%]" /><col className="w-[9%]" /><col className="w-[12%]" /><col className="w-[9%]" /><col className="w-[9%]" /><col className="w-[14%]" /><col className="w-[11%]" /><col className="w-[12%]" /><col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="text-ink-400 text-[11px] font-medium">
                <th className="text-left font-medium px-2.5 py-2">名称</th>
                <th className="text-left font-medium px-2.5 py-2">容量</th>
                <th className="text-left font-medium px-2.5 py-2">存储类</th>
                <th className="text-left font-medium px-2.5 py-2">访问</th>
                <th className="text-left font-medium px-2.5 py-2">Phase</th>
                <th className="text-left font-medium px-2.5 py-2">绑定到</th>
                <th className="text-left font-medium px-2.5 py-2">回收策略</th>
                <th className="text-left font-medium px-2.5 py-2">来源</th>
                <th className="text-right font-medium px-2.5 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {loadingPv ? (
                <TableSkeleton rows={3} cols={9} />
              ) : !Array.isArray(pvs) || pvs.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-400 text-[12px]">该集群暂无 PV</td></tr>
              ) : pagePvs.map((p: any) => (
                <tr key={p.name} className="border-t border-line hover:bg-subtle transition cursor-pointer" onClick={() => openDetail("pv", p.name)}>
                  <td className="px-2.5 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <HardDrive size={14} className="text-brand-500 shrink-0" />
                      <span className="font-mono text-ink-900 truncate" title={p.name}>{p.name}</span>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 font-mono text-ink-700 tabular-nums truncate" title={p.capacity}>{p.capacity}</td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={p.storageClass}>{p.storageClass || "—"}</td>
                  <td className="px-2.5 py-2"><span className="font-mono text-[11px] text-ink-500 bg-sunken rounded px-1.5 py-0.5">{p.accessModes || "—"}</span></td>
                  <td className="px-2.5 py-2"><StatusBadge kind={p.status} label={p.phase} /></td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={p.claim}>{p.claim || "—"}</td>
                  <td className="px-2.5 py-2"><StatusBadge kind={p.reclaimPolicy === "Retain" ? "warn" : "ok"} label={p.reclaimPolicy} /></td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={p.source}>{p.source}</td>
                  <td className="px-2.5 py-2 text-right">
                    <div className="inline-flex items-center gap-2 justify-end whitespace-nowrap">
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-brand-600"><FileText size={11} /> 详情</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingDelete({ kind: "pv", name: p.name }); }}
                        className="inline-flex items-center gap-1 text-[10.5px] text-err hover:bg-err/10 rounded px-1 py-0.5 transition"
                        title="删除 PV"
                      ><Trash2 size={11} /> 删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loadingPv && (
          <Pagination page={pvPage.page} totalPages={pvPage.totalPages} start={pvPage.start} end={pvPage.end} total={Array.isArray(pvs) ? pvs.length : 0} pageSize={pvPage.pageSize} onPageChange={pvPage.setPage} onPageSizeChange={pvPage.setPageSize} />
        )}
      </Card>

      {/* PVC 表格 */}
      <Card className="rise-4">
        <CardHead
          title="持久卷声明"
          sub={summary ? `${summary.pvcCount} 个 PVC · ${summary.boundCount} 已绑定 · 跨 ${totalNsCount} 个命名空间` : `${pvcs.length} 个 PVC · 跨 ${totalNsCount} 个命名空间`}
          right={<PrimaryButton icon={<Plus size={15} />} onClick={() => { setCreateErr(null); setPvcOpen(true); }}>创建 PVC</PrimaryButton>}
        />
        <div className="px-2 pb-2 overflow-x-auto">
          <table className="w-full table-fixed text-[12px] whitespace-nowrap">
            <colgroup>
              <col className="w-[14%]" /><col className="w-[12%]" /><col className="w-[9%]" /><col className="w-[9%]" /><col className="w-[12%]" /><col className="w-[9%]" /><col className="w-[14%]" /><col className="w-[9%]" /><col className="w-[12%]" />
            </colgroup>
            <thead>
              <tr className="text-ink-400 text-[11px] font-medium">
                <th className="text-left font-medium px-2.5 py-2">名称</th>
                <th className="text-left font-medium px-2.5 py-2">命名空间</th>
                <th className="text-left font-medium px-2.5 py-2">状态</th>
                <th className="text-left font-medium px-2.5 py-2">容量</th>
                <th className="text-left font-medium px-2.5 py-2">存储类</th>
                <th className="text-left font-medium px-2.5 py-2">访问</th>
                <th className="text-left font-medium px-2.5 py-2">绑定 PV</th>
                <th className="text-right font-medium px-2.5 py-2">时长</th>
                <th className="text-right font-medium px-2.5 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {loadingPvc ? (
                <TableSkeleton rows={4} cols={9} />
              ) : !Array.isArray(pvcs) || pvcs.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-400 text-[12px]">该集群暂无 PVC</td></tr>
              ) : pagePvcs.map((p: any) => (
                <tr key={`${p.namespace}/${p.name}`} className="border-t border-line hover:bg-subtle transition cursor-pointer" onClick={() => openDetail("pvc", p.name, p.namespace)}>
                  <td className="px-2.5 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <HardDrive size={14} className="text-brand-500 shrink-0" />
                      <span className="font-mono text-ink-900 truncate" title={p.name}>{p.name}</span>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={p.namespace}>{p.namespace}</td>
                  <td className="px-2.5 py-2"><StatusBadge kind={p.status} /></td>
                  <td className="px-2.5 py-2 font-mono text-ink-700 tabular-nums truncate" title={p.capacity}>{p.capacity}</td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={p.storageClass}>{p.storageClass || "—"}</td>
                  <td className="px-2.5 py-2"><span className="font-mono text-[11px] text-ink-500 bg-sunken rounded px-1.5 py-0.5">{p.access}</span></td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-ink-500 truncate" title={p.volume}>{p.volume || "—"}</td>
                  <td className="px-2.5 py-2 text-right font-mono text-[11px] text-ink-400">{p.age}</td>
                  <td className="px-2.5 py-2 text-right">
                    <div className="inline-flex items-center gap-2 justify-end whitespace-nowrap">
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-brand-600"><FileText size={11} /> 详情</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingDelete({ kind: "pvc", name: p.name, ns: p.namespace }); }}
                        className="inline-flex items-center gap-1 text-[10.5px] text-err hover:bg-err/10 rounded px-1 py-0.5 transition"
                        title="删除 PVC"
                      ><Trash2 size={11} /> 删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loadingPvc && (
          <Pagination page={pvcPage.page} totalPages={pvcPage.totalPages} start={pvcPage.start} end={pvcPage.end} total={Array.isArray(pvcs) ? pvcs.length : 0} pageSize={pvcPage.pageSize} onPageChange={pvcPage.setPage} onPageSizeChange={pvcPage.setPageSize} />
        )}
      </Card>

      {/* 新建存储类弹窗 */}
      <Modal
        open={scOpen}
        onClose={() => setScOpen(false)}
        title="新建存储类"
        desc="StorageClass · 定义置备器与回收策略"
        icon={<Layers size={15} />}
        footer={
          <>
            <button onClick={() => setScOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={createSc} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
          </>
        }
      >
        {createErr && <div className="mb-3"><ErrorBanner msg={createErr} /></div>}
        <Field label="名称"><TextInput value={sc.name} onChange={updSc("name")} placeholder="csi-nas-new" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="置备器"><TextInput value={sc.provisioner} onChange={updSc("provisioner")} placeholder="openebs.io/local" /></Field>
          <Field label="回收策略"><SelectInput value={sc.reclaim} onChange={updSc("reclaim")}><option>Delete</option><option>Retain</option></SelectInput></Field>
          <Field label="绑定模式" className="col-span-2"><SelectInput value={sc.bindMode} onChange={updSc("bindMode")}><option>Immediate</option><option>WaitForFirstConsumer</option></SelectInput></Field>
        </div>
      </Modal>

      {/* 创建 PVC 弹窗 */}
      <Modal
        open={pvcOpen}
        onClose={() => setPvcOpen(false)}
        title="创建持久卷声明"
        desc="PersistentVolumeClaim"
        icon={<HardDrive size={15} />}
        footer={
          <>
            <button onClick={() => setPvcOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={createPvc} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
          </>
        }
      >
        {createErr && <div className="mb-3"><ErrorBanner msg={createErr} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称"><TextInput value={pvc.name} onChange={updPvc("name")} placeholder="data-myapp" /></Field>
          <Field label="命名空间">
            <SelectInput value={pvc.namespace || "default"} onChange={updPvc("namespace")}>
              {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
            </SelectInput>
          </Field>
          <Field label="存储类"><TextInput value={pvc.storageClass} onChange={updPvc("storageClass")} placeholder={storageClasses[0]?.name ?? "local"} /></Field>
          <Field label="访问模式"><SelectInput value={pvc.access} onChange={updPvc("access")}><option>RWO</option><option>RWX</option><option>ROX</option></SelectInput></Field>
          <Field label="容量" className="col-span-2"><TextInput value={pvc.capacity} onChange={updPvc("capacity")} placeholder="10Gi" /></Field>
        </div>
      </Modal>

      {/* 新建 PV 弹窗 */}
      <Modal
        open={pvOpen}
        onClose={() => setPvOpen(false)}
        title="新建持久卷"
        desc="PersistentVolume · cluster-scoped 资源"
        icon={<HardDrive size={15} />}
        footer={
          <>
            <button onClick={() => setPvOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={createPv} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
          </>
        }
      >
        {createErr && <div className="mb-3"><ErrorBanner msg={createErr} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称"><TextInput value={pv.name} onChange={updPv("name")} placeholder="pv-demo-01" /></Field>
          <Field label="容量"><TextInput value={pv.capacity} onChange={updPv("capacity")} placeholder="10Gi" /></Field>
          <Field label="访问模式"><SelectInput value={pv.accessModes} onChange={updPv("accessModes")}><option>RWO</option><option>RWX</option><option>ROX</option></SelectInput></Field>
          <Field label="回收策略"><SelectInput value={pv.reclaimPolicy} onChange={updPv("reclaimPolicy")}><option>Delete</option><option>Retain</option></SelectInput></Field>
          <Field label="存储类" className="col-span-2"><TextInput value={pv.storageClass} onChange={updPv("storageClass")} placeholder="留空表示不绑定特定 StorageClass" /></Field>
          <Field label="来源类型" className="col-span-2"><SelectInput value={pv.sourceType} onChange={updPv("sourceType")}><option value="hostPath">HostPath</option><option value="nfs">NFS</option><option value="local">Local</option><option value="csi">CSI</option></SelectInput></Field>
        </div>
        {pv.sourceType === "hostPath" && (
          <div className="mt-3"><Field label="路径"><TextInput value={pv.sourceHostPath} onChange={updPv("sourceHostPath")} placeholder="/data/pv-demo" /></Field></div>
        )}
        {pv.sourceType === "nfs" && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="NFS Server"><TextInput value={pv.sourceNFSServer} onChange={updPv("sourceNFSServer")} placeholder="10.0.0.10" /></Field>
            <Field label="NFS 路径"><TextInput value={pv.sourceNFSPath} onChange={updPv("sourceNFSPath")} placeholder="/export/pv" /></Field>
          </div>
        )}
        {pv.sourceType === "local" && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="本地路径"><TextInput value={pv.sourceLocalPath} onChange={updPv("sourceLocalPath")} placeholder="/mnt/disks/ssd1" /></Field>
            <Field label="节点名称（可选·写入 nodeAffinity）"><TextInput value={pv.sourceLocalNode} onChange={updPv("sourceLocalNode")} placeholder="node-1" /></Field>
          </div>
        )}
        {pv.sourceType === "csi" && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="CSI Driver"><TextInput value={pv.sourceCSIDriver} onChange={updPv("sourceCSIDriver")} placeholder="com.example.csi" /></Field>
            <Field label="Volume Handle"><TextInput value={pv.sourceCSIVolumeHandle} onChange={updPv("sourceCSIVolumeHandle")} placeholder="vol-12345" /></Field>
            <Field label="FS Type（可选）" className="col-span-2"><TextInput value={pv.sourceCSIFSType} onChange={updPv("sourceCSIFSType")} placeholder="ext4" /></Field>
          </div>
        )}
      </Modal>

      {/* ========== 详情 + 编辑 弹窗（SC / PV / PVC 通用）========== */}
      <Modal
        open={detailKind !== null}
        onClose={closeDetail}
        title={detailTitle}
        desc="K8s 资源详情 · 可编辑字段随 K8s 规范"
        icon={detailKind === "sc" ? <Layers size={15} /> : <HardDrive size={15} />}
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
                <button
                  onClick={onDeleteFromDetail}
                  className="h-9 px-3 rounded-lg border border-err text-err text-[12.5px] font-medium hover:bg-err/10 transition"
                >
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
            {/* ===== StorageClass 详情 ===== */}
            {detailKind === "sc" && scDetail && (
              <>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <Info label="名称" value={scDetail.storageClass.name} mono />
                  <Info label="置备器" value={scDetail.storageClass.provisioner} mono />
                  <Info label="回收策略" value={scDetail.storageClass.reclaim} />
                  <Info label="绑定模式" value={scDetail.storageClass.bindMode} />
                  <Info label="默认" value={scDetail.storageClass.isDefault ? "true" : "false"} />
                  <Info label="关联 PV" value={`${scDetail.storageClass.volumes ?? 0} 个`} />
                </div>
                {/* parameters/annotations 编辑或查看 */}
                {editMode ? (
                  <div className="space-y-3">
                    <Field label="Parameters（key=value，每行一条）" hint="保存时与原值合并（已存在的 key 被替换）">
                      <textarea
                        value={editScParams}
                        onChange={(e) => setEditScParams(e.target.value)}
                        rows={4}
                        className="w-full font-mono text-[11.5px] bg-sunken border border-line rounded-md px-3 py-2 focus:outline-none focus:border-brand-500"
                      />
                    </Field>
                    <Field label="Annotations（key=value，每行一条）" hint="保存时与原值合并（已存在的 key 被替换）">
                      <textarea
                        value={editScAnnot}
                        onChange={(e) => setEditScAnnot(e.target.value)}
                        rows={5}
                        className="w-full font-mono text-[11.5px] bg-sunken border border-line rounded-md px-3 py-2 focus:outline-none focus:border-brand-500"
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">Parameters</div>
                      <div className="font-mono text-[11px] bg-sunken border border-line rounded-md p-2 max-h-32 overflow-y-auto">
                        {scDetail.parameters && Object.keys(scDetail.parameters).length > 0
                          ? Object.entries(scDetail.parameters).map(([k, v]) => <div key={k}><span className="text-brand-600">{k}</span>: {v}</div>)
                          : <span className="text-ink-300">（无）</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">Annotations</div>
                      <div className="font-mono text-[11px] bg-sunken border border-line rounded-md p-2 max-h-40 overflow-y-auto">
                        {scDetail.annotations && Object.keys(scDetail.annotations).length > 0
                          ? Object.entries(scDetail.annotations).map(([k, v]) => <div key={k}><span className="text-brand-600">{k}</span>: {v.length > 80 ? v.slice(0, 80) + "…" : v}</div>)
                          : <span className="text-ink-300">（无）</span>}
                      </div>
                    </div>
                  </div>
                )}
                {/* YAML */}
                <div>
                  <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">YAML 摘要</div>
                  <pre className="font-mono text-[11px] bg-sunken border border-line rounded-md p-3 max-h-72 overflow-auto whitespace-pre text-ink-700">{scDetail.yaml}</pre>
                </div>
              </>
            )}

            {/* ===== PersistentVolume 详情 ===== */}
            {detailKind === "pv" && pvDetailInfo && (
              <>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <Info label="名称" value={pvDetailInfo.persistentVolume.name} mono />
                  <Info label="Phase" value={pvDetailInfo.persistentVolume.phase} />
                  <Info label="容量" value={pvDetailInfo.persistentVolume.capacity} mono />
                  <Info label="存储类" value={pvDetailInfo.persistentVolume.storageClass || "—"} mono />
                  <Info label="访问模式" value={pvDetailInfo.persistentVolume.accessModes || "—"} mono />
                  <Info label="绑定到 PVC" value={pvDetailInfo.persistentVolume.claim || "—"} mono />
                  <Info label="回收策略" value={pvDetailInfo.persistentVolume.reclaimPolicy} />
                  <Info label="来源" value={pvDetailInfo.persistentVolume.source} mono />
                </div>
                {/* sourceRaw 展开 */}
                {pvDetailInfo.sourceRaw && Object.keys(pvDetailInfo.sourceRaw).length > 0 && (
                  <div>
                    <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">Source 详情</div>
                    <div className="font-mono text-[11px] bg-sunken border border-line rounded-md p-3 max-h-40 overflow-auto">
                      {Object.entries(pvDetailInfo.sourceRaw).map(([k, v]) => (
                        <div key={k}><span className="text-brand-600">{k}</span>: {String(v)}</div>
                      ))}
                    </div>
                  </div>
                )}
                {/* 编辑表单：reclaim + annotations */}
                {editMode ? (
                  <div className="space-y-3">
                    <Field label="回收策略" hint="仅 Delete / Retain">
                      <select value={editPvReclaimPolicy} onChange={(e) => setEditPvReclaimPolicy(e.target.value)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700">
                        <option>Delete</option><option>Retain</option>
                      </select>
                    </Field>
                    <Field label="Annotations（key=value，每行一条）">
                      <textarea value={editPvAnnot} onChange={(e) => setEditPvAnnot(e.target.value)} rows={5} className="w-full font-mono text-[11.5px] bg-sunken border border-line rounded-md px-3 py-2 focus:outline-none focus:border-brand-500" />
                    </Field>
                  </div>
                ) : (
                  <div>
                    <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">Annotations</div>
                    <div className="font-mono text-[11px] bg-sunken border border-line rounded-md p-2 max-h-32 overflow-y-auto">
                      {pvDetailInfo.persistentVolume.annotations && Object.keys(pvDetailInfo.persistentVolume.annotations).length > 0
                        ? Object.entries(pvDetailInfo.persistentVolume.annotations).map(([k, v]) => <div key={k}><span className="text-brand-600">{k}</span>: {v}</div>)
                        : <span className="text-ink-300">（无）</span>}
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">YAML 摘要</div>
                  <pre className="font-mono text-[11px] bg-sunken border border-line rounded-md p-3 max-h-72 overflow-auto whitespace-pre text-ink-700">{pvDetailInfo.yaml}</pre>
                </div>
              </>
            )}

            {/* ===== PersistentVolumeClaim 详情 ===== */}
            {detailKind === "pvc" && pvcDetailInfo && (
              <>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <Info label="名称" value={pvcDetailInfo.pvc.name} mono />
                  <Info label="命名空间" value={pvcDetailInfo.pvc.namespace} mono />
                  <Info label="状态" value={pvcDetailInfo.pvc.status} />
                  <Info label="容量" value={pvcDetailInfo.pvc.capacity} mono />
                  <Info label="存储类" value={pvcDetailInfo.pvc.storageClass || "—"} mono />
                  <Info label="访问模式" value={pvcDetailInfo.pvc.access || "—"} mono />
                  <Info label="绑定 PV" value={pvcDetailInfo.pvc.volume || "—"} mono />
                  <Info label="时长" value={pvcDetailInfo.pvc.age} />
                </div>
                {/* PVC 仅允许扩缩容 */}
                {editMode && (
                  <Field label="请求容量" hint="PVC 仅允许扩容（K8s 限制，openebs local 默认未开启扩容能力）">
                    <TextInput value={editPvcCapacity} onChange={(e) => setEditPvcCapacity(e.target.value)} placeholder="20Gi" />
                  </Field>
                )}
                <div>
                  <div className="text-[10.5px] uppercase text-ink-400 font-semibold mb-1">YAML 摘要</div>
                  <pre className="font-mono text-[11px] bg-sunken border border-line rounded-md p-3 max-h-72 overflow-auto whitespace-pre text-ink-700">{pvcDetailInfo.yaml}</pre>
                </div>
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
            <span className="mx-1 font-mono text-ink-900">{pendingDelete.kind === "sc" ? "StorageClass" : pendingDelete.kind === "pv" ? "PersistentVolume" : "PersistentVolumeClaim"}</span>
            <span className="font-mono text-err break-all">{pendingDelete.ns ? `${pendingDelete.ns}/${pendingDelete.name}` : pendingDelete.name}</span>
            <span className="text-ink-400"> 吗？此操作不可恢复，资源将从集群中直接移除。</span>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: unknown; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[10px] text-ink-400 mb-0.5">{label}</div>
      <div className={`${mono ? "font-mono" : ""} text-[12px] text-ink-800 truncate`} title={String(value ?? "")}>{String(value ?? "")}</div>
    </div>
  );
}