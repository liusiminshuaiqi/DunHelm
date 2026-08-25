import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Boxes, Workflow, Package, Server, HardDrive,
  Store, ChevronDown, ShieldCheck, Network, Building2, Users, KeyRound,
  CheckCircle2, Circle, Hammer, FileText,
} from "lucide-react";
import { useMyClusters, useMyMenus } from "@/data/useLive";
import { getCurrentUser } from "@/lib/api";
import { getCluster, getClusterSnapshot, setCluster, subscribeCluster } from "@/lib/cluster";
import type { ClusterSnapshot } from "@/lib/cluster";

export type ViewKey =
  | "overview" | "workloads" | "pipelines" | "registry" | "nodes"
  | "storage" | "market" | "network" | "workspaces" | "users" | "audit" | "credentials" | "clusters" | "buildconfig" | "config";

interface NavItem { key: ViewKey | string; label: string; icon: ReactNode; disabled?: boolean }
interface NavGroup { title: string; items: NavItem[] }

const groups: NavGroup[] = [
  {
    title: "概览",
    items: [{ key: "overview", label: "集群总览", icon: <LayoutDashboard size={16} /> }],
  },
  {
    title: "资源",
    items: [
      { key: "workloads", label: "工作负载", icon: <Boxes size={16} /> },
      { key: "nodes", label: "集群节点", icon: <Server size={16} /> },
      { key: "storage", label: "存储卷", icon: <HardDrive size={16} /> },
      { key: "network", label: "网络与存储", icon: <Network size={16} /> },
      { key: "config", label: "配置 (ConfigMap)", icon: <FileText size={16} /> },
    ],
  },
  {
    title: "DevOps",
    items: [
      { key: "pipelines", label: "流水线", icon: <Workflow size={16} /> },
      { key: "buildconfig", label: "构建配置", icon: <Hammer size={16} /> },
      { key: "registry", label: "镜像仓库", icon: <Package size={16} /> },
      { key: "market", label: "应用商店", icon: <Store size={16} /> },
      { key: "credentials", label: "代码凭证", icon: <KeyRound size={16} /> },
    ],
  },
  {
    title: "平台治理",
    items: [
      { key: "workspaces", label: "企业空间", icon: <Building2 size={16} /> },
      { key: "users", label: "用户与角色", icon: <Users size={16} /> },
      { key: "audit", label: "审计日志", icon: <ShieldCheck size={16} /> },
      { key: "clusters", label: "集群管理", icon: <Server size={16} /> },
    ],
  },
];

export function Sidebar({ active, onChange }: { active: ViewKey; onChange: (k: ViewKey) => void }) {
  const { data: clusters } = useMyClusters();
  const { data: menusData } = useMyMenus();
  const allowed = new Set(menusData.menus);
  const isPlatformAdmin = menusData.isPlatformAdmin;
  const me = getCurrentUser();
  const [cur, setCur] = useState<string>(() => getCluster());
  const [snap, setSnap] = useState<ClusterSnapshot | null>(() => getClusterSnapshot());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return subscribeCluster(() => {
      setCur(getCluster());
      setSnap(getClusterSnapshot());
    });
  }, []);

  // 尚未选择集群时（首次访问 / 刚清过缓存）自动选中一个可用集群。
  // 否则前端不传 cluster，后端会回退到「DB 中第一个集群」——若那个集群没配
  // kubeconfig，就会出现"我明明选的是 dev，却报 prod 未配置"的错觉。
  useEffect(() => {
    if (cur || clusters.length === 0) return;
    const pick = clusters.find((c) => c.health === "ready") ?? clusters[0];
    setCluster(String(pick.id), {
      name: pick.name,
      provider: pick.provider || "",
      region: pick.region || "",
      version: pick.version,
      clusterVersion: pick.clusterVersion,
    });
  }, [clusters, cur]);

  // 远端列表更新后，同步 clusterVersion / name 等元信息到本地快照
  useEffect(() => {
    if (!cur || clusters.length === 0) return;
    const live = clusters.find((c) => String(c.id) === cur);
    if (!live) return;
    setCluster(String(live.id), {
      name: live.name,
      provider: live.provider || "",
      region: live.region || "",
      version: live.version,
      clusterVersion: live.clusterVersion,
    });
    setSnap({ id: live.id, name: live.name, provider: live.provider, region: live.region, version: live.version, clusterVersion: live.clusterVersion });
  }, [clusters, cur]);

  const selectedCluster = clusters.find((c) => String(c.id) === cur);
  // 当前 cluster 必须落在用户有权限的 clusters 列表里才显示名称；否则视为未授权，不展示具体集群名
  const hasAccess = !!selectedCluster;
  const displayName = hasAccess ? (snap?.name || selectedCluster?.name || "") : "";
  const displayVer = hasAccess ? (snap?.clusterVersion || snap?.version || selectedCluster?.clusterVersion || selectedCluster?.version || "") : "";
  const displayProvider = hasAccess ? (snap?.provider || selectedCluster?.provider || "") : "";
  const isHealthy = selectedCluster?.connected ?? false;

  return (
    <aside className="w-[232px] flex-none h-full bg-gradient-to-b from-surface to-[#FBFDFF] border-r border-line relative flex flex-col">
      <div className="absolute top-0 right-[-1px] w-px h-44 bg-gradient-to-b from-transparent via-brand-300 to-transparent" />
      {/* 品牌 */}
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-line">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] relative overflow-hidden">
          <ShieldCheck size={16} className="text-white" />
          <div className="absolute inset-0 bg-gradient-to-br from-white/50 to-transparent" />
        </div>
        <div className="text-[15px] font-bold tracking-tight">
          Dun<span className="text-brand-600">Helm</span>
        </div>
        <span className="ml-auto font-mono text-[9px] font-semibold text-cyan-600 bg-cyan-100 px-1.5 py-0.5 rounded">PROD</span>
      </div>

      {/* 集群选择器（同步读 localStorage 快照，避免初次渲染显示陈旧 mock 数据） */}
      <div className="mx-3 mt-3 mb-1 relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full px-3 py-2 rounded-md bg-sunken border border-line flex items-center gap-2 text-left hover:border-brand-300 transition"
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full shrink-0",
              isHealthy ? "bg-ok animate-pulse-ring" : active ? "bg-warn" : "bg-idle",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-ink-900 truncate">
              {displayName || "选择集群"}
            </div>
            <div className="text-[10px] text-ink-400 font-mono truncate">
              {displayVer ? `${displayVer} · ${displayProvider || "—"}` : displayProvider || "尚未选择集群"}
            </div>
          </div>
          <ChevronDown size={14} className={cn("text-ink-400 transition shrink-0", open && "rotate-180")} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-0 right-0 top-11 z-20 rounded-xl border border-line bg-surface shadow-sh-3 overflow-hidden card-beam">
              <div className="px-3.5 py-2 border-b border-line bg-subtle">
                <span className="text-[11.5px] font-semibold text-ink-900">切换集群</span>
              </div>
              <div className="p-1.5 space-y-0.5 max-h-72 overflow-auto">
                {clusters.length === 0 && (
                  <div className="px-2.5 py-3 text-[11.5px] text-ink-400">暂未注册集群</div>
                )}
                {clusters.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCluster(String(c.id), {
                        name: c.name,
                        provider: c.provider || "",
                        region: c.region || "",
                        version: c.version,
                        clusterVersion: c.clusterVersion,
                      });
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-brand-50 transition",
                      String(c.id) === cur && "bg-brand-50",
                    )}
                  >
                    {c.connected ? (
                      <CheckCircle2 size={13} className="text-ok shrink-0" />
                    ) : (
                      <Circle size={13} className="text-ink-300 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] text-ink-900 truncate">{c.name}</div>
                      <div className="text-[10.5px] text-ink-400 truncate">{c.provider || "—"}</div>
                    </div>
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setOpen(false); onChange("clusters"); }}
                className="flex items-center gap-2 w-full px-3.5 py-2 text-left text-[12px] font-medium text-brand-700 hover:bg-brand-50 border-t border-line transition"
              >
                <Server size={14} /> 管理集群
              </button>
            </div>
          </>
        )}
      </div>

      {/* 导航 */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
        {groups.map((g) => {
          // 按当前用户可见菜单过滤；platform-admin 看全部
          const visibleItems = isPlatformAdmin ? g.items : g.items.filter((it) => allowed.has(String(it.key)));
          if (visibleItems.length === 0) return null;
          return (
            <div key={g.title}>
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-300">{g.title}</div>
              <div className="space-y-0.5">
                {visibleItems.map((it) => {
                  const isActive = !it.disabled && it.key === active;
                  return (
                    <button
                      key={it.key}
                      disabled={it.disabled}
                      onClick={() => !it.disabled && onChange(it.key as ViewKey)}
                      className={cn(
                        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium transition relative",
                        isActive
                          ? "bg-brand-50 text-brand-700"
                          : it.disabled
                            ? "text-ink-300 cursor-not-allowed"
                            : "text-ink-500 hover:bg-sunken hover:text-ink-900",
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-gradient-to-b from-brand-600 to-cyan-500" />
                      )}
                      <span className={cn(isActive ? "text-brand-600" : "")}>{it.icon}</span>
                      <span className="truncate">{it.label}</span>
                      {it.disabled && <span className="ml-auto text-[9px] font-mono text-ink-300 border border-line rounded px-1">soon</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* 用户 */}
      <div className="border-t border-line p-3 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[12px] font-bold">
          {(me?.username?.[0] ?? "U").toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-ink-900 truncate">{me?.username ?? "未知用户"}</div>
          <div className="text-[10px] text-ink-400 truncate">{me?.role ?? ""}</div>
        </div>
        <ChevronDown size={14} className="ml-auto text-ink-400" />
      </div>
    </aside>
  );
}
