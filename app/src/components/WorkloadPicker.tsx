// WorkloadPicker —— 「从工作负载同步 Selector」二级弹窗
// 用 useWorkloads() 拉取当前集群的 Deployment/StatefulSet/DaemonSet，
// 按 namespace 分组列出，每行展示 kind icon + ns/name + 关键 label preview；
// 选中一行点「应用此负载」回调 onPick，由调用方（如 Network.tsx）把
// workload.labels 合并进 Service selector 字符串。
//
// 与「工作负载选择器」手动键值对并列存在：用户既可保留手动键值对，
// 也可选一个工作负载自动填 label。

import { useMemo, useState } from "react";
import { Layers, Boxes, Database, Server, Search, ChevronRight, RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/primitives";
import { useWorkloads } from "@/data/useLive";
import { cn } from "@/lib/utils";

export interface WorkloadPick {
  kind: string;          // deployment | statefulset | daemonset
  namespace: string;
  name: string;
  labels: Record<string, string>;
  containerPorts?: { port: number; protocol: string }[];
}

const kindMeta: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  deployment:  { label: "Deploy",    icon: <Boxes size={12} />,      cls: "text-brand-600 bg-brand-50 border-brand-100" },
  statefulset: { label: "STS",       icon: <Database size={12} />,   cls: "text-cyan-600 bg-cyan-100 border-cyan-200" },
  daemonset:   { label: "DaemonSet", icon: <Server size={12} />,     cls: "text-warn bg-warn-bg border-warn" },
};

function K({ w }: { w: any }) {
  const meta = kindMeta[w.kind] ?? kindMeta.deployment;
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-[10.5px] rounded px-1.5 py-0.5 border whitespace-nowrap", meta.cls)}>
      {meta.icon} {meta.label}
    </span>
  );
}

export function WorkloadPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (w: WorkloadPick) => void;
}) {
  const live: any = useWorkloads();
  const loading = live?._loading === true;
  const err = live?._error as string | undefined;
  // useClusterFetch 返回的 live 同时是数组并带 _loading，mock fallback 也是数组
  const wls: any[] = Array.isArray(live) ? (live as any[]).filter((w) => !!w.kind) : [];

  const [search, setSearch] = useState("");
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  // 过滤（按名称 / ns / kind / 任意 label key/value）
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return wls;
    return wls.filter((w: any) =>
      (w.name || "").toLowerCase().includes(q) ||
      (w.namespace || "").toLowerCase().includes(q) ||
      (w.kind || "").toLowerCase().includes(q) ||
      Object.entries(w.labels || {}).some(([k, v]) =>
        k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q),
      ),
    );
  }, [wls, search]);

  // 按 namespace 分组并保持 ns 字典序，分组内再按 kind/name 字典序
  const grouped = useMemo(() => {
    const m = new Map<string, any[]>();
    filtered.forEach((w: any) => {
      const key = w.namespace || "(no namespace)";
      const arr = m.get(key) ?? [];
      arr.push(w);
      m.set(key, arr);
    });
    arrSortByKindName(m);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const picked = useMemo(() => {
    if (!pickedKey) return null;
    const [kind, ns, name] = pickedKey.split("|");
    return wls.find((w: any) => w.kind === kind && w.namespace === ns && w.name === name) ?? null;
  }, [pickedKey, wls]);

  const submit = () => {
    if (!picked) return;
    onPick({
      kind: picked.kind,
      namespace: picked.namespace,
      name: picked.name,
      labels: picked.labels || {},
      containerPorts: picked.containerPorts || [],
    });
    // 让调用方决定如何关闭（统一由它 reset 自身 state）
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="从工作负载同步"
      desc="从当前集群已存在的 Deployment / StatefulSet / DaemonSet 中选择，自动将其 labels 写入 Service Selector"
      icon={<Layers size={15} />}
      maxW="max-w-3xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!picked}
            className={cn(
              "h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition",
              !picked && "opacity-50 cursor-not-allowed hover:opacity-50",
            )}
          >
            应用此负载 <ChevronRight size={13} className="inline -mt-0.5 ml-0.5" />
          </button>
        </>
      }
    >
      {/* 顶部搜索 + 数量 */}
      <div className="flex items-center gap-2 px-3 h-9 rounded-lg bg-sunken border border-line focus-within:border-brand-300 focus-within:bg-surface transition">
        <Search size={15} className="text-ink-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-transparent outline-none text-[12.5px] w-full placeholder:text-ink-300"
          placeholder="按名称 / 命名空间 / 任意 label 筛选…"
        />
        <span className="font-mono text-[10.5px] text-ink-400 whitespace-nowrap">
          {filtered.length} / {wls.length}
        </span>
      </div>

      {err ? (
        <div className="rounded-lg border border-err bg-err-bg/30 px-3 py-2 text-[12px] text-err">
          加载工作负载失败：{err}
        </div>
      ) : loading && wls.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-6 text-ink-400 text-[12px] justify-center">
          <RefreshCw size={14} className="animate-spin" /> 正在从集群加载…
        </div>
      ) : wls.length === 0 ? (
        <div className="rounded-lg border border-line bg-subtle px-3 py-6 text-center text-ink-400 text-[12px]">
          当前集群没有 Deployment / StatefulSet / DaemonSet，请先在「工作负载」页创建工作负载后再来同步。
        </div>
      ) : (
        <div className="rounded-lg border border-line overflow-hidden">
          <div className="max-h-[420px] overflow-y-auto">
            {grouped.map(([ns, items]) => (
              <div key={ns} className="border-b border-line last:border-0">
                <div className="flex items-center gap-2 px-3 py-2 bg-subtle text-[11px] font-semibold text-ink-500 uppercase tracking-wider sticky top-0 z-10">
                  <Layers size={11} className="text-brand-500" />
                  <span className="font-mono">{ns}</span>
                  <span className="ml-auto font-mono text-ink-400 normal-case">{items.length}</span>
                </div>
                {items.map((w: any) => {
                  const key = `${w.kind}|${w.namespace}|${w.name}`;
                  const isPicked = pickedKey === key;
                  const labels = w.labels || {};
                  const labelEntries = Object.entries(labels).slice(0, 4);
                  const more = Object.keys(labels).length - labelEntries.length;
                  return (
                    <label
                      key={key}
                      className={cn(
                        "flex items-start gap-2.5 px-3 py-2.5 cursor-pointer border-t border-line/70 transition",
                        isPicked ? "bg-brand-50/70" : "hover:bg-brand-50/40",
                      )}
                    >
                      <input
                        type="radio"
                        name="wl-pick"
                        checked={isPicked}
                        onChange={() => setPickedKey(key)}
                        className="mt-1 accent-brand-600 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <K w={w} />
                          <span className="font-mono text-[12.5px] text-ink-900 truncate" title={w.name}>{w.name}</span>
                          <span className="font-mono text-[10.5px] text-ink-400 ml-auto">
                            {w.ready}/{w.desired} ready
                          </span>
                        </div>
                        {labelEntries.length === 0 ? (
                          <span className="font-mono text-[10.5px] text-ink-300">（无 labels）</span>
                        ) : (
                          <div className="flex items-center gap-1 flex-wrap">
                            {labelEntries.map(([k, v]) => (
                              <span
                                key={k}
                                className="inline-flex items-center gap-1 font-mono text-[10.5px] rounded px-1.5 py-0.5 bg-sunken text-ink-600 border border-line max-w-[260px]"
                                title={`${k}=${v}`}
                              >
                                <span className="text-brand-600">{k}</span>
                                <span className="text-ink-300">=</span>
                                <span className="truncate">{String(v)}</span>
                              </span>
                            ))}
                            {more > 0 && (
                              <span className="font-mono text-[10.5px] text-ink-400">+{more}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {picked && (
        <div className="rounded-lg border border-brand-200 bg-brand-50/40 px-3 py-2 text-[12px] text-ink-700 space-y-2">
          <div>
            <div className="text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1">将同步以下 Selector</div>
            <div className="font-mono text-[11.5px] text-ink-800 break-all leading-relaxed">
              {Object.keys(picked.labels || {}).length === 0
                ? <span className="text-ink-400">（所选工作负载未声明 labels，无法填入 Selector）</span>
                : Object.entries(picked.labels).map(([k, v], i) => (
                    <span key={k}>
                      {i > 0 && <span className="text-ink-300">, </span>}
                      <span className="text-brand-700">{k}</span>=<span>{String(v)}</span>
                    </span>
                  ))}
            </div>
          </div>
          <div>
            <div className="text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1">将同步以下容器端口 → 端口映射</div>
            {(picked.containerPorts || []).length === 0 ? (
              <span className="text-ink-400">（容器未声明 ports，端口映射保持不变）</span>
            ) : (
              <div className="flex items-center gap-1 flex-wrap font-mono text-[11.5px]">
                {(picked.containerPorts || []).map((cp: { port: number; protocol: string }, i: number) => (
                  <span key={`${cp.port}-${cp.protocol}-${i}`} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-surface border border-line">
                    <span className="text-ink-800">{cp.port}</span>
                    <span className="text-ink-300">/{cp.protocol}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function arrSortByKindName(m: Map<string, any[]>) {
  for (const arr of m.values()) {
    arr.sort((a, b) => {
      const k = (a.kind || "").localeCompare(b.kind || "");
      if (k !== 0) return k;
      return (a.name || "").localeCompare(b.name || "");
    });
  }
}
