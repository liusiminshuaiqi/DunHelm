import { useCallback, useEffect, useState } from "react";
import { apiGet, ApiError, getCurrentUser, type RegistryConn, type RoleRow, type UserRow, type UserClusterPermissionRow } from "@/lib/api";
import { getCluster, setCluster, subscribeCluster, subscribeClusterRegistry } from "@/lib/cluster";
import * as mock from "@/data/mock";

// 当前用户可见菜单（RBAC 控制 Sidebar 过滤）
export function useMyMenus() {
  const [data, setData] = useState<{ menus: string[]; isPlatformAdmin: boolean }>({ menus: [], isPlatformAdmin: false });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    apiGet<{ menus: string[]; isPlatformAdmin: boolean }>("/me/menus")
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ menus: [], isPlatformAdmin: false }); });
    return () => { alive = false; };
  }, [tick]);
  return { data, reload };
}

// useFetchR：同 useFetch，但额外返回 reload 用于写操作后主动刷新列表
function useFetchR<T extends object>(path: string, fallback: T): { data: T; reload: () => void } {
  const [data, setData] = useState<T>(fallback);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGet<T>(path)
      .then((d) => alive && setData(d))
      .catch((err: Error) => {
        if (!alive) return;
        const status = (err as ApiError).status;
        if (status === 403 || err.message.includes("403") || err.message.includes("no access to cluster")) {
          // 无权限：显示空数据，不回退 mock
          setData(emptyOf(fallback));
        }
        // 其他错误（网络/后端不可用）保持 mock fallback
      });
    return () => {
      alive = false;
    };
  }, [path, tick]);
  return { data, reload: () => setTick((t) => t + 1) };
}

// 订阅当前选中的集群（多集群切换）。导出供需随集群切换重拉数据的页面（如构建配置）使用。
export function useCluster(): string {
  const [c, setC] = useState<string>(() => getCluster());
  useEffect(() => subscribeCluster(() => setC(getCluster())), []);
  return c;
}

// 把 _error / _loading / reload 附加到数据上时，保持原始原型（关键：数组 fallback 不能用 {...arr}
// 那样会丢掉 Array.prototype，导致 .filter/.length/.map 全部炸）。
// 仅当 base 是数组时走 Array 分支（slice + Object.assign），否则走普通对象 spread。
function withMeta<T extends object>(
  base: T,
  meta: { _error?: string; _loading?: boolean; _permDenied?: boolean; reload?: () => void },
): T & { _error?: string; _loading?: boolean; _permDenied?: boolean; reload?: () => void } {
  if (Array.isArray(base)) {
    const arr = base.slice();
    Object.assign(arr, meta);
    return arr as unknown as T & { _error?: string; _loading?: boolean; reload?: () => void };
  }
  return { ...(base as object), ...meta } as T & { _error?: string; _loading?: boolean; reload?: () => void };
}

// emptyOf：把 fallback（mock 预制数据）递归清空——数组变 []、数字变 0、字符串变 ""、布尔变 false、
// 对象递归处理。用于「无集群权限」时返回与真实空数据同形状的结果，避免页面闪现/展示预制数据。
function emptyOf<T extends object>(base: T): T {
  if (Array.isArray(base)) return [] as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(base)) {
    const v = (base as Record<string, unknown>)[k];
    if (v === null) out[k] = null;
    else if (Array.isArray(v)) out[k] = [];
    else if (typeof v === "object") out[k] = emptyOf(v as object);
    else if (typeof v === "number") out[k] = 0;
    else if (typeof v === "boolean") out[k] = false;
    else out[k] = "";
  }
  return out as T;
}

// useClusterFetch：核心资源（集群/节点/工作负载/Job）按当前选中集群实时拉取；
// 关键 UX 决策：一旦用户已选择真实集群（localStorage 有 id），初始状态用 `_loading=true`
// 而不是 mock fallback，避免出现"先看到测试集群数据再看到真实数据"的闪烁；
// 尚未选择集群（首次打开 / 清空）时回退 mock（用作零数据空页）。
// 关键正确性：API 失败（502 等）或成功后，必须用 withMeta 保留 fallback/响应数据的原型，
// 否则数组类型 fallback 经对象展开后变 plain object，调用方 .filter/.length 直接炸。
// reload：写操作/安装组件后主动刷新列表（通过 tick 重新拉取）。
// 权限：接口返回 403（RequireClusterAccess 拦截，无该集群权限）时，显示空数据 + 标记，不回退 mock；
// 管理员未选集群时保持 mock fallback（演示数据），非管理员未选集群（即无任何可访问集群）直接空数据。
function useClusterFetch<T extends object>(path: string, fallback: T): T & { _error?: string; _loading?: boolean; _permDenied?: boolean; reload?: () => void } {
  const cluster = useCluster();
  const hasCluster = !!cluster;
  const isAdmin = getCurrentUser()?.role === "platform-admin";
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const [data, setData] = useState<T & { _error?: string; _loading?: boolean; _permDenied?: boolean; reload?: () => void }>(() =>
    hasCluster
      ? withMeta(fallback, { _loading: true, reload })
      : isAdmin
        ? withMeta(fallback, { reload })
        : withMeta(emptyOf(fallback), { _permDenied: true, reload }),
  );
  useEffect(() => {
    if (!cluster) {
      if (!isAdmin) {
        // 非管理员且无选中集群（通常意味着没有任何可访问集群）：显示空数据，不闪预制数据
        setData(withMeta(emptyOf(fallback), { _permDenied: true, reload }));
      }
      // 管理员未选集群：保持 mock fallback（演示数据）
      return;
    }
    let alive = true;
    setData((prev) => withMeta(prev, { _loading: true, reload }));
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}cluster=${encodeURIComponent(cluster)}`;
    apiGet<T>(url)
      .then((d) => {
        if (!alive) return;
        setData(withMeta(d, { _loading: false, reload }));
      })
      .catch((err: Error) => {
        if (!alive) return;
        const status = (err as ApiError).status;
        const is403 = status === 403 || err.message.includes("403") || err.message.includes("no access to cluster");
        if (is403) {
          // 无集群权限：显示空数据 + 标记，不回退 mock
          setData(withMeta(emptyOf(fallback), { _permDenied: true, _loading: false, reload }));
        } else {
          setData(withMeta(fallback, { _error: err.message, _loading: false, reload }));
        }
      });
    return () => {
      alive = false;
    };
  }, [path, cluster, tick, reload, isAdmin]);
  return data;
}

// useClusterData：包裹 useClusterFetch，对外返回与 useFetchR 一致的 { data, reload } 结构，
// 供原本按 useFetchR 习惯用 .data 访问的 DevOps 列表（流水线 / 构建 / 镜像仓库连接）使用，
// 同时仍按当前集群隔离数据。
function useClusterData<T extends object>(path: string, fallback: T): { data: T; _error?: string; _loading?: boolean; reload: () => void } {
  const r = useClusterFetch<T>(path, fallback);
  return { data: r, reload: r.reload ?? (() => {}) };
}

function kindOf(name: string): "deployment" | "statefulset" | "daemonset" {
  if (["elasticsearch", "grafana", "ai-train-operator"].includes(name)) return "statefulset";
  if (name === "gateway-envoy") return "daemonset";
  return "deployment";
}

export function useOverview() {
  const cluster = {
    name: mock.cluster.name,
    version: mock.cluster.version,
    provider: mock.cluster.provider,
    region: mock.cluster.region,
    nodes: mock.cluster.nodes,
    pods: mock.cluster.pods,
    cpuUsed: mock.cluster.cpu.used,
    cpuTotal: mock.cluster.cpu.total,
    memUsed: mock.cluster.mem.used,
    memTotal: mock.cluster.mem.total,
  };
  return useClusterFetch("/overview", {
    cluster,
    trend: mock.trend24h,
    namespaces: mock.namespaces,
    nodes: mock.nodes,
    events: mock.events,
  });
}

export function useNodes() {
  const total = mock.nodes.length;
  const ready = mock.nodes.filter((n) => n.status === "ok").length;
  const cpuRate = Math.round(mock.nodes.reduce((a, n) => a + n.cpu, 0) / total);
  const memRate = Math.round(mock.nodes.reduce((a, n) => a + n.mem, 0) / total);
  return useClusterFetch("/nodes", {
    kpi: { total, ready, cpuRate, memRate, metricsReady: false },
    nodes: mock.nodes,
  });
}

export function useWorkloads() {
  return useClusterFetch(
    "/workloads",
    mock.workloads.map((w) => ({ ...w, kind: kindOf(w.name) })),
  );
}

export function useJobs(kind: "job" | "cronjob") {
  return useClusterFetch(`/jobs?kind=${kind}`, kind === "job" ? mock.jobs : mock.cronjobs);
}

export function usePipelines() {
  return useClusterData<typeof mock.pipelines>("/pipelines", mock.pipelines);
}

export function useBuilds(pipeline?: string) {
  const path = pipeline ? `/builds?pipeline=${encodeURIComponent(pipeline)}` : "/builds";
  return useClusterData<typeof mock.buildRecords>(path, mock.buildRecords);
}

export function useRepos() {
  return useFetchR("/repos", { repos: mock.repos, storage: mock.registryStorage });
}

// ---------- 平台治理 ----------
export function useWorkspaces() {
  return useFetchR("/workspaces", mock.workspaces);
}

export function useUsers() {
  // 后端 UserRow，mock fallback 用空数组（保持类型兼容）
  return useFetchR<UserRow[]>("/users", [] as UserRow[]);
}

export function useRoles() {
  return useFetchR<RoleRow[]>("/roles", [] as RoleRow[]);
}

export function useUserPermissions(userId: number) {
  return useFetchR<UserClusterPermissionRow[]>(`/users/${userId}/permissions`, [] as UserClusterPermissionRow[]);
}

export function useAudit() {
  // 新接口返回 {items, total}，fallback 用 mock 包成同样结构
  return useFetchR<{ items: unknown[]; total: number }>("/audit", { items: mock.auditLogs, total: mock.auditLogs.length });
}

// ---------- 网络与存储 ----------
// 已切真实集群时不再闪 mock（与 useNodes/useWorkloads 一致），按当前选中集群实时拉取；
// 未选集群则回退 mock.storageClasses / mock.pvcs。
export function useStorageClasses() {
  return useClusterFetch<typeof mock.storageClasses>("/storage-classes", mock.storageClasses);
}

export function usePVCs() {
  return useClusterFetch<typeof mock.pvcs>("/pvcs", mock.pvcs);
}

// PV 列表（真实集群；mock 未提供 PV 故 fallback 是 []）
export function usePVs() {
  return useClusterFetch<[]>("/pvs", []);
}

// 存储 KPI 汇总（仅在真实集群上有意义）；未选集群时返回 null 触发前端 fallback）
export interface StorageSummaryData {
  storageClassCount: number;
  pvCount: number;
  pvcCount: number;
  boundCount: number;
  bindRate: number;
  totalCapacityBytes: number;
  requestedBytes: number;
  defaultStorageClass: string;
}
export function useStorageSummary() {
  const cluster = useCluster();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const [data, setData] = useState<StorageSummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!cluster) {
      setData(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    apiGet<StorageSummaryData>(`/storage-summary?cluster=${encodeURIComponent(cluster)}`)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((err: Error) => { if (alive) { setError(err.message); setLoading(false); } });
    return () => { alive = false; };
  }, [cluster, tick]);
  return { data, loading, error, reload };
}

export function useServices() {
  return useClusterFetch<typeof mock.services>("/services", mock.services);
}

export function useIngresses() {
  return useClusterFetch<typeof mock.ingresses>("/ingresses", mock.ingresses);
}

export function useCredentials() {
  return useClusterFetch("/credentials", mock.credentials);
}

// 镜像仓库连接列表（多仓库）：与集群无关，直接拉 /registries。
export function useRegistries() {
  return useClusterData<RegistryConn[]>("/registries", []);
}

// 命名空间列表（供创建类弹窗选择，避免用户手填）：
// 按当前选中集群实时拉取真实命名空间；未选集群 / 拉取失败时回退 ["default"]。
export function useNamespaces(): string[] {
  const r = useClusterFetch<{ name: string }[]>("/namespaces", []);
  const arr = Array.isArray(r) ? r : [];
  const names = arr.map((n) => (n && n.name) || "").filter(Boolean);
  return names.length > 0 ? names : ["default"];
}

// 集群列表（多集群），供 Topbar 切换与集群管理页使用
export type ClusterRow = {
  id: number;
  name: string;
  version: string;
  provider: string;
  region: string;
  connected: boolean;
  /** 后端探测健康状态：ready | no-kubeconfig | parse-error | connect-error */
  health?: string;
  /** 探测失败时的真实原因（不含 kubeconfig 内容） */
  healthMessage?: string;
  /** 真实 K8s 服务端版本（仅 connected 时返回） */
  clusterVersion?: string;
};
export function useClusters() {
  return useFetchR<ClusterRow[]>("/clusters", []);
}

// useMyClusters：当前用户可访问的集群（平台管理员看全部；其他用户按 UserClusterPermission 过滤）
// 返回值与 useClusters 兼容（数组），但浏览器无权限的集群不会出现在下拉里。
export function useMyClusters() {
  const [data, setData] = useState<ClusterRow[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    apiGet<{ clusters: ClusterRow[]; isPlatformAdmin: boolean }>("/clusters/me")
      .then((d) => {
        if (!alive) return;
        const clusters = d.clusters || [];
        setData(clusters);
        // 防御性清理：若当前选中的集群已不在可用列表中，立即清空本地缓存，避免下拉框显示已删除集群
        const cur = getCluster();
        if (cur && !clusters.some((c) => String(c.id) === cur)) {
          setCluster("");
        }
      })
      .catch(() => { if (alive) setData([]); });
    return () => { alive = false; };
  }, [tick]);
  useEffect(() => subscribeClusterRegistry(reload), [reload]);
  return { data, reload };
}
