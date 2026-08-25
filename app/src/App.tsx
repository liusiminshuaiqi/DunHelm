import { useEffect, useMemo, useState } from "react";
import { Sidebar, type ViewKey } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { Overview } from "@/pages/Overview";
import { Login } from "@/pages/Login";
import { Workloads, type DetailNav, type WType } from "@/pages/Workloads";
import { Pipelines } from "@/pages/Pipelines";
import { Registry } from "@/pages/Registry";
import { Nodes } from "@/pages/Nodes";
import { Storage } from "@/pages/Storage";
import { Market } from "@/pages/Market";
import { Network } from "@/pages/Network";
import { Workspaces } from "@/pages/Workspaces";
import { Users } from "@/pages/Users";
import { Audit } from "@/pages/Audit";
import { Credentials } from "@/pages/Credentials";
import { Clusters } from "@/pages/Clusters";
import { BuildConfig } from "@/pages/BuildConfig";
import { Config } from "@/pages/Config";
import { useClusters, useMyMenus } from "@/data/useLive";
import { getCluster, getClusterSnapshot, subscribeCluster } from "@/lib/cluster";
import { getCurrentUser, onAuthChange, type AuthUser } from "@/lib/api";

const meta: Record<ViewKey, string> = {
  overview: "",
  nodes: "",
  workloads: "Deployments / StatefulSets / DaemonSets",
  pipelines: "CI / CD 持续交付流水线",
  registry: "Harbor 兼容私有容器镜像仓库",
  storage: "StorageClass / PVC / 容量配额",
  market: "一键部署的官方与社区应用模板",
  network: "Service / Ingress / 网络策略",
  workspaces: "多租户隔离 · 资源配额管理",
  users: "RBAC 授权 · 成员管理",
  audit: "操作审计 · 合规留存",
  credentials: "Git / 镜像仓库 / SSH / KubeConfig 凭据",
  clusters: "注册与管理多集群 KubeConfig 接入",
  buildconfig: "平台级 Maven 全局配置（mirror / proxy）",
  config: "集群 ConfigMap 浏览与整体覆盖",
};

const VIEW_KEY = "kubehelm.view";
const VALID_VIEWS: ViewKey[] = [
  "overview", "workloads", "pipelines", "registry", "nodes",
  "storage", "market", "network", "workspaces", "users", "audit", "credentials", "clusters", "buildconfig", "config",
];
const VALID_DETAIL_TABS = new Set<string>(["deployment", "statefulset", "daemonset", "job", "cronjob"]);

function loadView(): ViewKey {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v && (VALID_VIEWS as string[]).includes(v)) return v as ViewKey;
  } catch {
    /* localStorage 不可用时回退总览 */
  }
  return "overview";
}

// 将 (view, detail) 编码进 URL hash：#/<view>[/detail/<type>/<tab>/<ns>/<name>]
// 这样浏览器刷新 / 前进后退都能还原到当前视图与详情子页，且不依赖 React 内存状态。
function buildHash(view: ViewKey, detail: DetailNav | null): string {
  if (!detail) return `#/${view}`;
  return `#/${view}/detail/${detail.type}/${detail.tab}/${encodeURIComponent(detail.namespace)}/${encodeURIComponent(detail.name)}`;
}

function buildPipelineHash(n: PipelineNav): string {
  if (n.kind === "new") return "#/pipelines/new";
  if (n.kind === "detail") {
    const t = n.tab && PIPELINE_TABS.has(n.tab) ? n.tab : "basic";
    return `#/pipelines/detail/${encodeURIComponent(n.name)}/${t}`;
  }
  return "#/pipelines";
}

function parsePipelineHash(): PipelineNav | null {
  const raw = window.location.hash.replace(/^#\/?pipelines\/?/, "").trim();
  if (!raw) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === "new") return { kind: "new" };
  if (parts[0] === "detail" && parts.length >= 2) {
    const name = decodeURIComponent(parts[1]);
    const tab = parts[2] && PIPELINE_TABS.has(parts[2]) ? parts[2] : "canvas";
    return { kind: "detail", name, tab };
  }
  return null;
}

// 解析 hash 还原 view + detail（detail 为可序列化的 ns+name 元组，不含 row）
function parseHash(): { view: ViewKey; detail: DetailNav | null } {
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  if (!raw) return { view: loadView(), detail: null };
  const parts = raw.split("/");
  const v = parts[0];
  if (!(VALID_VIEWS as string[]).includes(v)) return { view: "overview", detail: null };
  const view = v as ViewKey;
  // 详情仅对 workloads 视图有意义
  if (view === "workloads" && parts[1] === "detail" && parts.length >= 6 && VALID_DETAIL_TABS.has(parts[3])) {
    const type = parts[2] === "job" ? "job" : "workload";
    const tab = parts[3] as WType;
    return { view, detail: { type, tab, namespace: decodeURIComponent(parts[4]), name: decodeURIComponent(parts[5]) } };
  }
  return { view, detail: null };
}

const TITLES: Record<ViewKey, string> = {
  overview: "集群总览",
  workloads: "工作负载",
  pipelines: "流水线",
  registry: "镜像仓库",
  nodes: "集群节点",
  storage: "存储卷",
  market: "应用商店",
  network: "网络与存储",
  workspaces: "企业空间",
  users: "用户与角色",
  audit: "审计日志",
  credentials: "代码凭证",
  clusters: "集群管理",
  buildconfig: "构建配置",
  config: "配置 (ConfigMap)",
};

export type PipelineNav =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "detail"; name: string; tab?: string };
export type PipelineTab = "canvas" | "builds" | "run";
const PIPELINE_TABS = new Set<string>(["canvas", "builds", "run"]);

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(getCurrentUser());
  useEffect(() => onAuthChange(setUser), []);

  const initial = useMemo(() => parseHash(), []);
  const [view, setView] = useState<ViewKey>(initial.view);
  const [snap, setSnap] = useState(() => getClusterSnapshot());
  const [curId, setCurId] = useState<string>(() => getCluster());
  const { data: clusters } = useClusters();
  const { data: menusData } = useMyMenus();
  const allowedMenus = new Set(menusData.menus);
  // 路由守卫：当前 view 不在用户可见菜单中时跳回 overview
  useEffect(() => {
    if (menusData.isPlatformAdmin) return;
    if (allowedMenus.size === 0) return; // 初次加载未完成
    if (!allowedMenus.has(view)) {
      setView("overview");
      window.location.hash = "#/overview";
    }
  }, [view, menusData]);
  // 工作负载详情子页签导航（null 表示停留在列表）；仅含可序列化的 (type,tab,ns,name) 元组
  const [detailNav, setDetailNav] = useState<DetailNav | null>(initial.detail);
  // 流水线子页签导航（list/new/detail）；null=默认列表
  const [pipelineNav, setPipelineNav] = useState<PipelineNav>(parsePipelineHash() ?? { kind: "list" });

  useEffect(() => subscribeCluster(() => {
    setSnap(getClusterSnapshot());
    setCurId(getCluster());
  }), []);

  // 远端集群列表就绪后用真实 clusterVersion 覆盖本地快照
  useEffect(() => {
    if (!curId || clusters.length === 0) return;
    const live = clusters.find((c) => String(c.id) === curId);
    if (!live) return;
    setSnap({
      id: live.id,
      name: live.name,
      provider: live.provider,
      region: live.region,
      version: live.version,
      clusterVersion: live.clusterVersion,
    });
  }, [clusters, curId]);

  const change = (k: ViewKey) => {
    setView(k);
    setDetailNav(null);
    setPipelineNav({ kind: "list" });
    try { localStorage.setItem(VIEW_KEY, k); } catch { /* 忽略写入失败 */ }
    // 同步 URL hash（浏览器前进/后退也能还原）
    window.location.hash = buildHash(k, null);
  };

  // 进入 / 退出工作负载详情：把可序列化的 detail 元组写入 URL hash
  const handleNavigate = (d: DetailNav | null) => {
    setDetailNav(d);
    window.location.hash = buildHash("workloads", d);
  };

  // 进入 / 切换 / 退出流水线子页：写入 hash 并同步本地 state
  const handlePipelineNav = (n: PipelineNav) => {
    setPipelineNav(n);
    window.location.hash = buildPipelineHash(n);
  };

  // 浏览器前进 / 后退：hash 变化后同步 view 与 detailNav
  useEffect(() => {
    const onHash = () => {
      const p = parseHash();
      setView(p.view);
      setDetailNav(p.detail);
      if (p.view === "pipelines") {
        setPipelineNav(parsePipelineHash() ?? { kind: "list" });
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [view]);

  const subtitle = useMemo(() => {
    if (view === "overview") {
      if (!curId) return "尚未选择集群 · 数据为示例";
      if (snap) {
        const ver = snap.clusterVersion || snap.version || "—";
        const prov = snap.provider || "—";
        return `${snap.name} · ${ver} · ${prov}`;
      }
      return "加载集群信息…";
    }
    if (view === "nodes") {
      if (snap) return `${snap.name} · 节点健康度 · ${snap.clusterVersion || snap.version || "—"}`;
      return "节点运行状态 · 资源使用率";
    }
    return meta[view] ?? "";
  }, [view, curId, snap]);

  const m = { title: TITLES[view], subtitle };
  if (!user) return <Login />;
  return (
    <div className="flex h-screen w-full overflow-hidden bg-app">
      <Sidebar active={view} onChange={change} />
      <main className="flex-1 flex flex-col min-w-0">
        <Topbar title={m.title} subtitle={m.subtitle} onManageClusters={() => change("clusters")} />
        <div className="flex-1 overflow-y-auto bg-grid">
          {view === "overview" && <Overview />}
          {view === "workloads" && <Workloads detailNav={detailNav} onNavigate={handleNavigate} />}
          {view === "pipelines" && <Pipelines nav={pipelineNav} onNav={handlePipelineNav} />}
          {view === "registry" && <Registry />}
          {view === "nodes" && <Nodes />}
          {view === "storage" && <Storage />}
          {view === "market" && <Market />}
          {view === "network" && <Network />}
          {view === "workspaces" && <Workspaces />}
          {view === "users" && <Users />}
          {view === "audit" && <Audit />}
          {view === "credentials" && <Credentials />}
          {view === "clusters" && <Clusters />}
          {view === "buildconfig" && <BuildConfig />}
          {view === "config" && <Config />}
        </div>
      </main>
    </div>
  );
}
