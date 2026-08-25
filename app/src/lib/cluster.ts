// 全局选中的集群（多集群）。状态存 localStorage，并通过简单订阅机制
// 在 Topbar 选择与核心数据 hook 之间保持同步。
//
// 设计要点：
// - `getCluster()` 同步返回当前选中集群 id（来自 localStorage），可在 React
//   render 阶段直接使用，无需等异步接口。订阅用于跨组件同步。
// - 同时把选中集群的关键元信息（名称/提供商/版本/区域）也同步存入
//   `kubehelm.cluster.info`，这样侧栏集群卡片、App 标题、Topbar 状态徽章都能
//   **零延迟**反映"切到了哪个集群"，避免显示陈旧 mock.cluster 信息。

const KEY_ID = "kubehelm.cluster";
const KEY_INFO = "kubehelm.cluster.info";

export type ClusterSnapshot = {
  id: number;
  name: string;
  provider: string;
  region: string;
  /** 注册时用户填的版本（若无则为 "—"） */
  version?: string;
  /** 后端真实探测到的 apiserver 版本（仅 ready 时填充） */
  clusterVersion?: string;
};

type Listener = () => void;
let listeners: Listener[] = [];

type RegistryListener = () => void;
let registryListeners: RegistryListener[] = [];

/** 当前选中的集群 ID（同步）。 */
export function getCluster(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(KEY_ID) || "";
}

/** 当前选中的集群快照（同步）。无缓存或 id 不匹配时返回 null。 */
export function getClusterSnapshot(): ClusterSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY_INFO);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClusterSnapshot;
    const id = localStorage.getItem(KEY_ID) || "";
    if (!id || String(parsed.id) !== id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 设置当前集群，并把快照写入 localStorage 以便同步访问 */
export function setCluster(id: string, snapshot?: Omit<ClusterSnapshot, "id">): void {
  if (id) {
    localStorage.setItem(KEY_ID, id);
    if (snapshot) {
      const s: ClusterSnapshot = { id: Number(id), ...snapshot };
      // 移除 undefined 字段，避免 JSON.stringify 把它当成 string 写入
      const clean: Record<string, unknown> = { id: s.id };
      for (const [k, v] of Object.entries(s)) {
        if (v != null && v !== "") clean[k] = v;
      }
      try { localStorage.setItem(KEY_INFO, JSON.stringify(clean)); } catch { /* 忽略 */ }
    }
  } else {
    localStorage.removeItem(KEY_ID);
    localStorage.removeItem(KEY_INFO);
  }
  listeners.forEach((l) => l());
}

export function subscribeCluster(l: Listener): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

/** 集群注册表（增删改）变化通知。用于 Sidebar/Topbar 的「我的集群」列表与集群管理页保持同步。 */
export function subscribeClusterRegistry(l: RegistryListener): () => void {
  registryListeners.push(l);
  return () => {
    registryListeners = registryListeners.filter((x) => x !== l);
  };
}

export function emitClusterRegistryChanged(): void {
  registryListeners.forEach((l) => l());
}
