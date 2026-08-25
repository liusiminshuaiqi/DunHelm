import { useEffect, useState, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Card, ErrorBanner,
  usePagination, Pagination,
} from "@/components/ui/primitives";
import { useNamespaces } from "@/data/useLive";
import { getCluster, getClusterSnapshot } from "@/lib/cluster";
import { apiGet, apiSend } from "@/lib/api";
import { FileText, Plus, RefreshCw, Search, Trash2, Save, XCircle, Loader2, Database } from "lucide-react";

// 后端返回类型
type CmsSummary = { name: string; keyCount: number; dataBytes: number };
type CmsListResp = { namespace: string; items: CmsSummary[] };
type CmsDetail = {
  name: string; namespace: string;
  data: Record<string, string>;
  binaryData: Record<string, string>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
};
type KVPair = { id: string; key: string; value: string };

const uid = () => Math.random().toString(36).slice(2, 9);

// 把后端返回的 data 转成 key/value 编辑器所需的临时结构
function dataToPairs(d: Record<string, string>): KVPair[] {
  const keys = Object.keys(d || {}).sort();
  return keys.map((k) => ({ id: uid(), key: k, value: d[k] ?? "" }));
}

// 兜底：后端 map 字段为 nil → 反序列化后是 null/undefined；Object.keys(null) 会炸。
// 这里集中规整，让组件主体可以无脑调用。
function normMap(m: Record<string, string> | null | undefined): Record<string, string> {
  return m && typeof m === "object" ? m : {};
}

// 自动撑高 textarea：每次输入后高度 = 内容 scrollHeight（带 min/max 兜底）
// textarea 高度由 style.height 内联控制，min/max 与 className 中的 Tailwind 一致
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto"; // 先重置才能拿到真实 scrollHeight
  const min = 120;
  const max = 480;
  const next = Math.min(max, Math.max(min, el.scrollHeight));
  el.style.height = `${next}px`;
}

export function Config() {
  const namespaces = useNamespaces();
  // namespace 选择（默认 default；首次进页面时切换到 default）
  const [ns, setNs] = useState<string>("default");
  // 列表
  const [list, setList] = useState<CmsSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listErr, setListErr] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  // 当前选中的 ConfigMap
  const [pickedName, setPickedName] = useState<string>("");
  // 详情
  const [detail, setDetail] = useState<CmsDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailErr, setDetailErr] = useState<string>("");
  // 编辑缓冲（key/value 表单）；与 detail 解耦，点保存才提交
  const [pairs, setPairs] = useState<KVPair[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string>("");
  const [saveErr, setSaveErr] = useState<string>("");
  // textarea refs（按 pair.id），用来在拉详情完成后给所有 textarea 一次性 autosize
  const taRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  // 当前集群 id（从 localStorage 拿）；空表示未选
  const clusterId = (() => {
    const cur = getCluster();
    if (!cur) return "";
    return cur;
  })();

  const clusterName = (() => {
    const snap = getClusterSnapshot();
    return snap?.name || `cluster#${clusterId}`;
  })();

  // 拉取 ConfigMap 列表（依赖 ns + cluster）
  const loadList = async () => {
    if (!clusterId) {
      setListErr("请先在顶部选择集群");
      setList([]);
      return;
    }
    setLoadingList(true);
    setListErr("");
    try {
      const data = await apiGet<CmsListResp>(
        `/configmaps?cluster=${encodeURIComponent(clusterId)}&namespace=${encodeURIComponent(ns)}`,
      );
      setList(Array.isArray(data.items) ? data.items : []);
      // 切 namespace 时清空选中项
      setPickedName("");
      setDetail(null);
      setPairs([]);
    } catch (e: any) {
      setListErr(e?.message || "加载 ConfigMap 列表失败");
      setList([]);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, ns]);

  // 拉取 ConfigMap 详情
  const loadDetail = async (name: string) => {
    if (!clusterId || !name) return;
    setLoadingDetail(true);
    setDetailErr("");
    setSaveMsg("");
    setSaveErr("");
    try {
      const data = await apiGet<CmsDetail>(
        `/configmaps/get?cluster=${encodeURIComponent(clusterId)}&namespace=${encodeURIComponent(ns)}&name=${encodeURIComponent(name)}`,
      );
      // 后端虽然已 ensureMap，但万一老版本/缓存/类型不严，给前端再兜一层
      const safe: CmsDetail = {
        ...data,
        data: normMap(data.data),
        binaryData: normMap(data.binaryData),
        labels: normMap(data.labels),
        annotations: normMap(data.annotations),
      };
      setDetail(safe);
      setPairs(dataToPairs(safe.data));
    } catch (e: any) {
      setDetailErr(e?.message || "加载 ConfigMap 详情失败");
      setDetail(null);
      setPairs([]);
    } finally {
      setLoadingDetail(false);
    }
  };

  // 选中名字变化时拉详情
  useEffect(() => {
    if (pickedName) loadDetail(pickedName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedName]);

  // pairs 变化（含首次拉详情后）后批量 autosize（双 rAF 确保 layout 已计算）
  useEffect(() => {
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => {
        Object.values(taRefs.current).forEach(autosize);
      });
    });
    return () => {
      cancelAnimationFrame(id1);
      if (id2) cancelAnimationFrame(id2);
    };
  }, [pairs]);

  // 搜索过滤（按 name）
  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q));
  }, [list, search]);

  // 列表分页
  const pag = usePagination(filteredList.length, 12);
  useEffect(() => { pag.setPage(1); }, [search, ns]); // eslint-disable-line react-hooks/exhaustive-deps

  // 编辑器操作
  const addPair = () => setPairs((ps) => [...ps, { id: uid(), key: "", value: "" }]);
  const updatePair = (id: string, k: "key" | "value", v: string) =>
    setPairs((ps) => ps.map((p) => (p.id === id ? { ...p, [k]: v } : p)));
  const removePair = (id: string) => setPairs((ps) => ps.filter((p) => p.id !== id));

  const dirty = useMemo(() => {
    if (!detail) return false;
    const orig = dataToPairs(detail.data);
    if (orig.length !== pairs.length) return true;
    const origMap = new Map(orig.map((p) => [p.key, p.value]));
    for (const p of pairs) {
      if (!p.key.trim()) continue; // 空 key 跳过（仍算 dirty）
      if (!origMap.has(p.key) || origMap.get(p.key) !== p.value) return true;
    }
    // 检查是否删了原 key
    const pairKeys = new Set(pairs.map((p) => p.key).filter(Boolean));
    for (const k of origMap.keys()) if (!pairKeys.has(k)) return true;
    return false;
  }, [detail, pairs]);

  const save = async () => {
    if (!detail || !clusterId) return;
    // 校验：所有非空 key 必须唯一
    const seen = new Set<string>();
    const data: Record<string, string> = {};
    for (const p of pairs) {
      const k = p.key.trim();
      if (!k) continue;
      if (seen.has(k)) {
        setSaveErr(`存在重复 key: ${k}`);
        return;
      }
      seen.add(k);
      data[k] = p.value;
    }
    setSaving(true);
    setSaveMsg("");
    setSaveErr("");
    try {
      await apiSend("PUT",
        `/configmaps/update?cluster=${encodeURIComponent(clusterId)}&namespace=${encodeURIComponent(ns)}&name=${encodeURIComponent(detail.name)}`,
        { data },
      );
      setSaveMsg("保存成功");
      // 保存后重新拉详情 + 列表（key 数量会变）
      await loadDetail(detail.name);
      await loadList();
    } catch (e: any) {
      setSaveErr(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="top-aura relative p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold text-ink-900 flex items-center gap-2">
            <FileText size={18} className="text-fuchsia-600" /> 配置 (ConfigMap)
          </h2>
          <p className="text-[12px] text-ink-500 mt-0.5">
            浏览集群 <span className="font-mono">{clusterName}</span> 下的 ConfigMap，可编辑 data 字段后整体覆盖保存
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadList}
            disabled={!clusterId || loadingList}
            className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw size={13} className={loadingList ? "animate-spin" : ""} /> 刷新列表
          </button>
        </div>
      </div>

      {!clusterId && (
        <ErrorBanner msg="尚未选择集群：请在左侧集群选择器中选一个集群后再来。" kind="generic" />
      )}
      {listErr && <ErrorBanner msg={listErr} kind="cluster" />}

      <div className="grid grid-cols-[360px_1fr] gap-4">
        {/* 左列：namespace + ConfigMap 列表 */}
        <Card beam={false} className="p-3.5 space-y-2.5">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase font-semibold tracking-wider text-brand-700">
            <Database size={11} /> 命名空间
          </div>
          <SelectInline
            value={ns}
            options={namespaces}
            onChange={setNs}
          />
          <div className="flex items-center gap-2 px-2.5 h-8 rounded-md bg-sunken border border-line focus-within:border-brand-300">
            <Search size={13} className="text-ink-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="按 ConfigMap 名筛选…"
              className="bg-transparent outline-none text-[12px] flex-1 placeholder:text-ink-300"
            />
            <span className="font-mono text-[10px] text-ink-400">{filteredList.length}/{list.length}</span>
          </div>
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
            {loadingList && list.length === 0 ? (
              <div className="px-3 py-6 text-center text-ink-400 text-[12px] flex items-center justify-center gap-2">
                <Loader2 size={13} className="animate-spin" /> 加载中…
              </div>
            ) : filteredList.length === 0 ? (
              <div className="px-3 py-6 text-center text-ink-400 text-[12px]">
                {search ? "无匹配 ConfigMap" : "该命名空间下没有任何 ConfigMap"}
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredList.slice(pag.start, pag.end).map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setPickedName(c.name)}
                    className={cn(
                      "w-full text-left px-2.5 py-2 rounded-md text-[12px] flex items-center gap-2 transition",
                      pickedName === c.name
                        ? "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200"
                        : "hover:bg-sunken text-ink-700",
                    )}
                  >
                    <FileText size={12} className="shrink-0 text-fuchsia-500" />
                    <span className="font-mono truncate flex-1">{c.name}</span>
                    <span className="font-mono text-[10px] text-ink-400 shrink-0">{c.keyCount} keys · {formatBytes(c.dataBytes)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {pag.totalPages > 1 && (
            <Pagination {...pag} onPageChange={pag.setPage} onPageSizeChange={pag.setPageSize} />
          )}
        </Card>

        {/* 右列：详情 + 编辑器 */}
        <Card beam={false} className="p-4">
          {!pickedName ? (
            <div className="grid place-items-center h-[400px] text-[13px] text-ink-400">
              从左侧选一个 ConfigMap
            </div>
          ) : loadingDetail ? (
            <div className="grid place-items-center h-[400px] text-[13px] text-ink-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> 加载中…
            </div>
          ) : detailErr ? (
            <ErrorBanner msg={detailErr} kind="cluster" />
          ) : detail ? (
            <div className="space-y-3">
              {/* 顶部 meta */}
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold text-ink-900 font-mono flex items-center gap-2">
                    <FileText size={15} className="text-fuchsia-600 shrink-0" />
                    <span className="truncate">{detail.name}</span>
                  </div>
                  <div className="text-[11.5px] text-ink-500 font-mono mt-0.5 truncate">
                    namespace: {detail.namespace}
                    {Object.keys(detail.labels).length > 0 && <> · labels: {Object.keys(detail.labels).length}</>}
                    {Object.keys(detail.annotations).length > 0 && <> · annotations: {Object.keys(detail.annotations).length}</>}
                    {Object.keys(detail.binaryData).length > 0 && <> · binaryData: {Object.keys(detail.binaryData).length}</>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {dirty && <span className="text-[10.5px] font-mono text-warn">● 未保存</span>}
                  <button
                    onClick={save}
                    disabled={saving || !dirty}
                    className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    保存
                  </button>
                </div>
              </div>

              {saveMsg && (
                <div className="text-[11.5px] text-ok bg-ok-bg/40 border border-ok/30 rounded px-2.5 py-1.5">{saveMsg}</div>
              )}
              {saveErr && <ErrorBanner msg={saveErr} kind="generic" />}

              {/* key/value 编辑器 */}
              <div className="flex items-center justify-between">
                <div className="text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 flex items-center gap-1.5">
                  data · {pairs.filter((p) => p.key.trim()).length} 项
                </div>
                <button
                  onClick={addPair}
                  className="h-7 px-2.5 rounded-md border border-line bg-surface text-[11.5px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition inline-flex items-center gap-1"
                >
                  <Plus size={11} /> 新增键
                </button>
              </div>
              {pairs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line bg-sunken/40 px-3 py-6 text-center text-[12px] text-ink-400">
                  此 ConfigMap 没有 data，可点上方「新增键」添加
                </div>
              ) : (
                <div className="space-y-1.5">
                  {pairs.map((p) => (
                    <div key={p.id} className="grid grid-cols-[180px_1fr_32px] gap-2 items-start">
                      <input
                        value={p.key}
                        onChange={(e) => updatePair(p.id, "key", e.target.value)}
                        placeholder="key"
                        className="h-9 px-2.5 rounded-md bg-surface border border-line text-[12px] font-mono focus:outline-none focus:border-brand-300 focus:shadow-[0_0_0_3px_rgba(19,96,196,.10)]"
                      />
                      <textarea
                        value={p.value}
                        onChange={(e) => updatePair(p.id, "value", e.target.value)}
                        placeholder="value（多行内容可自动撑高）"
                        ref={(el) => {
                          taRefs.current[p.id] = el;
                          // ref 回调在 commit 阶段调，element 已挂载；立即 autosize 一次
                          // 用双 rAF 保险：第一帧让 React 完成 paint，第二帧才读 scrollHeight
                          if (el) requestAnimationFrame(() => requestAnimationFrame(() => autosize(el)));
                        }}
                        onInput={(e) => autosize(e.currentTarget)}
                        rows={4}
                        className="px-2.5 py-1.5 rounded-md bg-surface border border-line text-[12px] font-mono leading-5 focus:outline-none focus:border-brand-300 focus:shadow-[0_0_0_3px_rgba(19,96,196,.10)]"
                        style={{ minHeight: 120, maxHeight: 480 }}
                      />
                      <button
                        onClick={() => removePair(p.id)}
                        title="删除该行"
                        className="h-9 w-8 rounded-md border border-line bg-surface text-ink-500 hover:text-err hover:border-err/40 transition inline-flex items-center justify-center"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* labels / annotations 展示（只读；后续可扩展编辑） */}
              {(Object.keys(detail.labels).length > 0 || Object.keys(detail.annotations).length > 0) && (
                <div className="pt-3 mt-2 border-t border-line space-y-2">
                  {Object.keys(detail.labels).length > 0 && (
                    <div>
                      <div className="text-[10.5px] uppercase font-semibold tracking-wider text-ink-400 mb-1">labels（只读）</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(detail.labels).map(([k, v]) => (
                          <span key={k} className="font-mono text-[10.5px] rounded px-1.5 py-0.5 border border-line bg-sunken text-ink-600">
                            {k}={v}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {Object.keys(detail.annotations).length > 0 && (
                    <div>
                      <div className="text-[10.5px] uppercase font-semibold tracking-wider text-ink-400 mb-1">annotations（只读）</div>
                      <div className="space-y-1">
                        {Object.entries(detail.annotations).map(([k, v]) => (
                          <AnnotationRow key={k} k={k} v={v} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

// AnnotationRow：annotations 只读展示行
//   - key 过长（> 40 字符）截断中间加 …
//   - value 过长用 line-clamp-2 限 2 行高（≈ 32px），整体不再被长文撑高
//   - 完整 key + value 走 title 悬停可看；点击展开/收起
function AnnotationRow({ k, v }: { k: string; v: string }) {
  const [open, setOpen] = useState(false);
  const MAX_KEY = 40;
  const MAX_VALUE_PREVIEW = 80;
  const kDisplay = k.length > MAX_KEY ? k.slice(0, MAX_KEY - 1) + "…" : k;
  const vDisplay = !open && v.length > MAX_VALUE_PREVIEW ? v.slice(0, MAX_VALUE_PREVIEW - 1) + "…" : v;
  const longValue = v.length > MAX_VALUE_PREVIEW;
  return (
    <div
      className="font-mono text-[10.5px] rounded px-1.5 py-1 border border-line bg-sunken text-ink-600 cursor-default"
      title={`${k}=${v}`}
      onClick={longValue ? () => setOpen((o) => !o) : undefined}
    >
      <span className="font-semibold text-brand-700 break-all">{kDisplay}</span>
      <span className="text-ink-400 mx-1">=</span>
      <span
        className={!open ? "line-clamp-2 break-all whitespace-pre-wrap" : "whitespace-pre-wrap break-all"}
        style={!open ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}
      >
        {vDisplay}
      </span>
      {longValue && (
        <span className="ml-1.5 text-[10px] text-brand-600 font-medium">
          {open ? "[收起]" : "[展开]"}
        </span>
      )}
    </div>
  );
}

// 简单的内联下拉（避免依赖未存在的 SelectInput 原生组件）
function SelectInline({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 h-8 px-2.5 rounded-md bg-surface border border-line text-[12px] font-mono focus:outline-none focus:border-brand-300"
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "0B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}
void XCircle; // 避免 unused 警告（保留图标供未来"取消编辑"使用）