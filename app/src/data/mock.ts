// 集中 Mock 数据层 —— 高保真前端原型，后续可替换为真实 kube-apiserver 响应

export type StatusKind = "ok" | "warn" | "err" | "info" | "idle" | "running" | "pending" | "updating";

// ============ 集群总览 ============
export const cluster = {
  name: "prod-cluster-01",
  version: "v1.29.4",
  provider: "Tencent TKE",
  region: "ap-guangzhou",
  nodes: 18,
  pods: 642,
  cpu: { used: 312, total: 576, unit: "cores" },
  mem: { used: 1184, total: 2304, unit: "Gi" },
};

export const trend24h = Array.from({ length: 24 }, (_, h) => {
  const base = 46 + Math.sin((h / 24) * Math.PI * 2) * 16;
  const noise = (Math.sin(h * 1.7) + Math.cos(h * 0.9)) * 4;
  const cpu = Math.max(18, Math.min(92, Math.round(base + noise)));
  const mem = Math.max(30, Math.min(88, Math.round(base * 0.92 + noise * 0.6 + 8)));
  return { h: `${String(h).padStart(2, "0")}:00`, cpu, mem };
});

export const namespaces = [
  { name: "kube-system", cpu: 78, mem: 64, pods: 92 },
  { name: "ns-payment", cpu: 56, mem: 71, pods: 148 },
  { name: "ns-order", cpu: 43, mem: 52, pods: 121 },
  { name: "ns-gateway", cpu: 88, mem: 60, pods: 36 },
  { name: "ns-ai-train", cpu: 34, mem: 79, pods: 64 },
  { name: "ns-monitor", cpu: 41, mem: 47, pods: 58 },
];

export const nodes = [
  { name: "node-gz-01", role: "control-plane", status: "ok", cpu: 38, mem: 55, disk: 41, pods: 41, podTotal: 110, version: "v1.29.4", ip: "10.0.12.11", os: "Ubuntu 22.04", kubelet: "v1.29.4", age: "188d" },
  { name: "node-gz-02", role: "control-plane", status: "ok", cpu: 42, mem: 60, disk: 38, pods: 38, podTotal: 110, version: "v1.29.4", ip: "10.0.12.12", os: "Ubuntu 22.04", kubelet: "v1.29.4", age: "188d" },
  { name: "node-gz-03", role: "worker", status: "ok", cpu: 67, mem: 73, disk: 62, pods: 52, podTotal: 110, version: "v1.29.4", ip: "10.0.13.21", os: "Ubuntu 22.04", kubelet: "v1.29.4", age: "176d" },
  { name: "node-gz-04", role: "worker", status: "warn", cpu: 91, mem: 84, disk: 88, pods: 61, podTotal: 110, version: "v1.29.4", ip: "10.0.13.22", os: "Ubuntu 22.04", kubelet: "v1.29.4", age: "176d" },
  { name: "node-gz-05", role: "worker", status: "ok", cpu: 58, mem: 49, disk: 51, pods: 44, podTotal: 110, version: "v1.29.4", ip: "10.0.13.23", os: "Ubuntu 22.04", kubelet: "v1.29.4", age: "120d" },
  { name: "node-gz-06", role: "worker", status: "updating", cpu: 12, mem: 22, disk: 18, pods: 9, podTotal: 110, version: "v1.29.4", ip: "10.0.13.24", os: "Ubuntu 22.04", kubelet: "v1.29.4", age: "3d" },
];

export const events = [
  { time: "16:42", type: "ok", reason: "Pulled", obj: "payment-api-7d9f", msg: "Successfully pulled image registry.local/payment:1.8.2" },
  { time: "16:39", type: "warn", reason: "OOMKilled", obj: "train-worker-3", msg: "Container exceeded memory limit 4Gi, restarted" },
  { time: "16:31", type: "info", reason: "Scaling", obj: "gateway-hpa", msg: "Scaled up from 4 to 6 replicas (CPU 88%)" },
  { time: "16:28", type: "err", reason: "BackOff", obj: "order-svc-5c2", msg: "ImagePullBackOff: manifest unknown for order:latest" },
  { time: "16:20", type: "ok", reason: "Created", obj: "monitor-grafana", msg: "Started container grafana" },
  { time: "16:11", type: "info", reason: "Sync", obj: "coredns", msg: "ConfigMap reloaded, 6 upstreams" },
  { time: "16:02", type: "ok", reason: "Ready", obj: "node-gz-06", msg: "Node cordon lifted, scheduling enabled" },
];

// ============ 工作负载 ============
export interface Workload {
  name: string;
  namespace: string;
  status: StatusKind;
  desired: number;
  ready: number;
  image: string;
  cpu: number; // millicores
  restarts: number;
  age: string;
  pods: StatusKind[];
  /** 由 useWorkloads 运行时补齐（deployment/statefulset/daemonset） */
  kind?: "deployment" | "statefulset" | "daemonset";
}

export const workloads: Workload[] = [
  {
    name: "payment-api", namespace: "ns-payment", status: "ok", desired: 6, ready: 6,
    image: "registry.local/payment:1.8.2", cpu: 320, restarts: 0, age: "42d",
    pods: ["ok", "ok", "ok", "ok", "ok", "ok"],
  },
  {
    name: "order-svc", namespace: "ns-order", status: "updating", desired: 5, ready: 4,
    image: "registry.local/order:2.3.0", cpu: 410, restarts: 1, age: "12d",
    pods: ["ok", "ok", "ok", "ok", "updating"],
  },
  {
    name: "gateway-envoy", namespace: "ns-gateway", status: "ok", desired: 6, ready: 6,
    image: "registry.local/envoy:1.29", cpu: 180, restarts: 0, age: "88d",
    pods: ["ok", "ok", "ok", "ok", "ok", "ok"],
  },
  {
    name: "ai-train-operator", namespace: "ns-ai-train", status: "err", desired: 3, ready: 1,
    image: "registry.local/ai-operator:0.9.1", cpu: 920, restarts: 7, age: "3d",
    pods: ["err", "err", "ok"],
  },
  {
    name: "user-svc", namespace: "ns-payment", status: "ok", desired: 4, ready: 4,
    image: "registry.local/user:4.1.0", cpu: 210, restarts: 0, age: "21d",
    pods: ["ok", "ok", "ok", "ok"],
  },
  {
    name: "notify-worker", namespace: "ns-order", status: "pending", desired: 2, ready: 0,
    image: "registry.local/notify:1.2.0", cpu: 0, restarts: 0, age: "5m",
    pods: ["pending", "pending"],
  },
  {
    name: "grafana", namespace: "ns-monitor", status: "ok", desired: 1, ready: 1,
    image: "registry.local/grafana:11.0", cpu: 95, restarts: 0, age: "120d",
    pods: ["ok"],
  },
  {
    name: "elasticsearch", namespace: "ns-monitor", status: "ok", desired: 3, ready: 3,
    image: "registry.local/es:8.13", cpu: 640, restarts: 2, age: "120d",
    pods: ["ok", "ok", "ok"],
  },
];

// ============ 流水线 ============
export type StageStatus = "pending" | "running" | "ok" | "err" | "aborted";
export interface Pipeline {
  name: string;
  repo: string;
  branch: string;
  lastStatus: StatusKind;
  duration: string;
  trigger: string;
  env?: string;
  lastRun: string;
  stages: { name: string; status: StageStatus }[];
  spark: number[];
}
export interface BuildStage {
  name: string;
  status: StageStatus;
  log?: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface Build {
  id: string;
  pipeline: string;
  status: StatusKind | "aborted";
  branch: string;
  trigger: string;
  duration: string;
  time: string;
  stages?: BuildStage[];
}
export const pipelines: Pipeline[] = [
  {
    name: "payment-api-ci", repo: "plat/payment-api", branch: "main", lastStatus: "ok",
    duration: "4m12s", trigger: "push", lastRun: "16:38",
    stages: [
      { name: "Clone", status: "ok" }, { name: "Build", status: "ok" },
      { name: "Test", status: "ok" }, { name: "Image", status: "ok" }, { name: "Deploy", status: "ok" },
    ],
    spark: [62, 70, 58, 74, 80, 66, 88, 76, 90, 84],
  },
  {
    name: "order-svc-cd", repo: "plat/order-svc", branch: "release/2.3", lastStatus: "running",
    duration: "2m48s", trigger: "merge", lastRun: "16:40",
    stages: [
      { name: "Clone", status: "ok" }, { name: "Build", status: "ok" },
      { name: "Test", status: "running" }, { name: "Image", status: "pending" }, { name: "Deploy", status: "pending" },
    ],
    spark: [40, 52, 48, 60, 55, 70, 64, 78, 72, 81],
  },
  {
    name: "gateway-envoy-ci", repo: "infra/envoy", branch: "main", lastStatus: "ok",
    duration: "6m03s", trigger: "schedule", lastRun: "15:55",
    stages: [
      { name: "Clone", status: "ok" }, { name: "Build", status: "ok" },
      { name: "Test", status: "ok" }, { name: "Image", status: "ok" }, { name: "Deploy", status: "pending" },
    ],
    spark: [30, 35, 42, 38, 50, 47, 55, 60, 58, 64],
  },
  {
    name: "ai-operator-build", repo: "ml/ai-operator", branch: "dev", lastStatus: "err",
    duration: "1m20s", trigger: "push", lastRun: "16:18",
    stages: [
      { name: "Clone", status: "ok" }, { name: "Build", status: "err" },
      { name: "Test", status: "pending" }, { name: "Image", status: "pending" }, { name: "Deploy", status: "pending" },
    ],
    spark: [20, 28, 24, 30, 26, 18, 22, 15, 12, 10],
  },
  {
    name: "user-svc-ci", repo: "plat/user-svc", branch: "main", lastStatus: "ok",
    duration: "3m31s", trigger: "push", lastRun: "16:02",
    stages: [
      { name: "Clone", status: "ok" }, { name: "Build", status: "ok" },
      { name: "Test", status: "ok" }, { name: "Image", status: "ok" }, { name: "Deploy", status: "ok" },
    ],
    spark: [50, 58, 54, 62, 68, 60, 72, 70, 78, 82],
  },
];

export const buildRecords = [
  { id: "#2841", pipeline: "payment-api-ci", status: "ok", branch: "main", trigger: "push", duration: "4m12s", time: "16:38" },
  { id: "#2840", pipeline: "order-svc-cd", status: "running", branch: "release/2.3", trigger: "merge", duration: "2m48s", time: "16:40" },
  { id: "#2839", pipeline: "ai-operator-build", status: "err", branch: "dev", trigger: "push", duration: "1m20s", time: "16:18" },
  { id: "#2838", pipeline: "user-svc-ci", status: "ok", branch: "main", trigger: "push", duration: "3m31s", time: "16:02" },
  { id: "#2837", pipeline: "gateway-envoy-ci", status: "ok", branch: "main", trigger: "schedule", duration: "6m03s", time: "15:55" },
  { id: "#2836", pipeline: "payment-api-ci", status: "ok", branch: "main", trigger: "push", duration: "4m05s", time: "15:30" },
  { id: "#2835", pipeline: "notify-worker-ci", status: "ok", branch: "main", trigger: "push", duration: "2m11s", time: "15:12" },
];

// ============ 镜像仓库 ============
export interface RepoTag {
  name: string;
  size: string;
  pushed: string;
  vuln: { critical: number; high: number; medium: number; low: number };
}
export interface Repo {
  id?: number;
  name: string;
  visibility: "public" | "private";
  favorite?: boolean;
  tags: number;
  size: string;
  pulls: number;
  lastPush: string;
  tagList: RepoTag[];
}
export const repos: Repo[] = [
  {
    name: "registry.local/payment", visibility: "private", favorite: true, tags: 12, size: "2.4 GiB", pulls: 1843, lastPush: "16:38",
    tagList: [
      { name: "1.8.2", size: "210 MiB", pushed: "16:38", vuln: { critical: 0, high: 0, medium: 1, low: 3 } },
      { name: "1.8.1", size: "208 MiB", pushed: "2d", vuln: { critical: 0, high: 1, medium: 2, low: 4 } },
      { name: "latest", size: "210 MiB", pushed: "16:38", vuln: { critical: 0, high: 0, medium: 1, low: 3 } },
    ],
  },
  {
    name: "registry.local/order", visibility: "private", favorite: true, tags: 9, size: "1.8 GiB", pulls: 1202, lastPush: "16:40",
    tagList: [
      { name: "2.3.0", size: "196 MiB", pushed: "16:40", vuln: { critical: 0, high: 0, medium: 0, low: 2 } },
      { name: "2.2.5", size: "194 MiB", pushed: "5d", vuln: { critical: 1, high: 2, medium: 3, low: 5 } },
    ],
  },
  {
    name: "registry.local/envoy", visibility: "public", tags: 6, size: "980 MiB", pulls: 5621, lastPush: "3d",
    tagList: [
      { name: "1.29", size: "162 MiB", pushed: "3d", vuln: { critical: 0, high: 0, medium: 0, low: 1 } },
      { name: "1.28", size: "158 MiB", pushed: "20d", vuln: { critical: 0, high: 1, medium: 1, low: 2 } },
    ],
  },
  {
    name: "registry.local/ai-operator", visibility: "private", favorite: true, tags: 4, size: "3.1 GiB", pulls: 318, lastPush: "16:18",
    tagList: [
      { name: "0.9.1", size: "780 MiB", pushed: "3d", vuln: { critical: 0, high: 0, medium: 2, low: 4 } },
      { name: "0.9.0", size: "775 MiB", pushed: "11d", vuln: { critical: 2, high: 3, medium: 4, low: 6 } },
    ],
  },
  {
    name: "registry.local/grafana", visibility: "public", tags: 8, size: "1.2 GiB", pulls: 9044, lastPush: "12d",
    tagList: [
      { name: "11.0", size: "148 MiB", pushed: "12d", vuln: { critical: 0, high: 0, medium: 1, low: 2 } },
    ],
  },
  {
    name: "registry.local/es", visibility: "private", tags: 5, size: "4.6 GiB", pulls: 2210, lastPush: "30d",
    tagList: [
      { name: "8.13", size: "612 MiB", pushed: "30d", vuln: { critical: 0, high: 1, medium: 2, low: 3 } },
    ],
  },
];

export const registryStorage = { used: 13.2, total: 50, unit: "GiB" };

// ============ 存储卷 ============
export interface StorageClass {
  name: string;
  provisioner: string;
  reclaim: "Delete" | "Retain";
  bindMode: "Immediate" | "WaitForFirstConsumer";
  isDefault: boolean;
  volumes: number;
}
export const storageClasses: StorageClass[] = [
  { name: "csi-ssd", provisioner: "com.tencent.csi.cbs", reclaim: "Delete", bindMode: "Immediate", isDefault: true, volumes: 142 },
  { name: "csi-essd", provisioner: "com.tencent.csi.cbs", reclaim: "Retain", bindMode: "Immediate", isDefault: false, volumes: 38 },
  { name: "csi-nas", provisioner: "com.tencent.csi.nas", reclaim: "Retain", bindMode: "WaitForFirstConsumer", isDefault: false, volumes: 21 },
  { name: "local-storage", provisioner: "kubernetes.io/no-provisioner", reclaim: "Delete", bindMode: "WaitForFirstConsumer", isDefault: false, volumes: 12 },
];

export interface PVC {
  name: string;
  namespace: string;
  status: StatusKind;
  capacity: string;
  used: number; // percent
  storageClass: string;
  volume: string;
  access: "RWO" | "RWX" | "ROX";
  age: string;
}
export const pvcs: PVC[] = [
  { name: "data-payment-0", namespace: "ns-payment", status: "ok", capacity: "200Gi", used: 64, storageClass: "csi-ssd", volume: "pvc-7f3a", access: "RWO", age: "42d" },
  { name: "data-order-0", namespace: "ns-order", status: "ok", capacity: "120Gi", used: 51, storageClass: "csi-ssd", volume: "pvc-9c1b", access: "RWO", age: "12d" },
  { name: "es-data", namespace: "ns-monitor", status: "ok", capacity: "500Gi", used: 78, storageClass: "csi-essd", volume: "pvc-2d8e", access: "RWX", age: "120d" },
  { name: "model-cache", namespace: "ns-ai-train", status: "warn", capacity: "1Ti", used: 93, storageClass: "csi-essd", volume: "pvc-5a0f", access: "RWO", age: "3d" },
  { name: "grafana-pv", namespace: "ns-monitor", status: "ok", capacity: "20Gi", used: 33, storageClass: "csi-ssd", volume: "pvc-1b6c", access: "RWO", age: "120d" },
  { name: "shared-nas", namespace: "ns-gateway", status: "ok", capacity: "2Ti", used: 41, storageClass: "csi-nas", volume: "pvc-8e44", access: "RWX", age: "88d" },
  { name: "pending-pvc", namespace: "ns-order", status: "pending", capacity: "50Gi", used: 0, storageClass: "csi-ssd", volume: "—", access: "RWO", age: "5m" },
  { name: "local-audit", namespace: "kube-system", status: "ok", capacity: "100Gi", used: 22, storageClass: "local-storage", volume: "pvc-3f72", access: "RWO", age: "188d" },
];

// ============ 应用商店 ============
export interface AppTemplate {
  name: string;
  category: "数据库" | "中间件" | "AI" | "Web" | "监控" | "DevOps";
  desc: string;
  icon: string; // 首字母 / 缩写
  official: boolean;
  deploys: number;
  rating: number;
  version: string;
}
export const marketTemplates: AppTemplate[] = [
  { name: "MySQL", category: "数据库", desc: "高可用主从架构，自动备份与故障切换", icon: "My", official: true, deploys: 1843, rating: 4.8, version: "8.4" },
  { name: "Redis", category: "数据库", desc: "内存KV存储，支持主从与哨兵模式", icon: "Rd", official: true, deploys: 2110, rating: 4.9, version: "7.2" },
  { name: "PostgreSQL", category: "数据库", desc: "企业级开源关系型数据库", icon: "Pg", official: true, deploys: 962, rating: 4.7, version: "16.2" },
  { name: "Kafka", category: "中间件", desc: "分布式消息队列，海量吞吐", icon: "Kf", official: true, deploys: 543, rating: 4.6, version: "3.7" },
  { name: "RabbitMQ", category: "中间件", desc: "轻量级 AMQP 消息中间件", icon: "Rb", official: false, deploys: 388, rating: 4.5, version: "3.13" },
  { name: "Nginx Ingress", category: "Web", desc: "七层流量入口与负载均衡", icon: "Ng", official: true, deploys: 2871, rating: 4.8, version: "1.25" },
  { name: "MinIO", category: "中间件", desc: "S3 兼容对象存储", icon: "Mo", official: false, deploys: 274, rating: 4.4, version: "RELEASE.2024" },
  { name: "Prometheus", category: "监控", desc: "云原生指标监控与告警", icon: "Pr", official: true, deploys: 1562, rating: 4.9, version: "2.52" },
  { name: "Grafana", category: "监控", desc: "可视化仪表盘平台", icon: "Gr", official: true, deploys: 1490, rating: 4.9, version: "11.0" },
  { name: "vLLM", category: "AI", desc: "高性能大模型推理服务", icon: "vL", official: false, deploys: 121, rating: 4.6, version: "0.5.3" },
  { name: "GitLab", category: "DevOps", desc: "一体化代码托管与 CI", icon: "Gl", official: false, deploys: 209, rating: 4.3, version: "17.1" },
  { name: "Harbor", category: "DevOps", desc: "企业级镜像仓库（已内置）", icon: "Hb", official: true, deploys: 334, rating: 4.7, version: "2.11" },
];

// ============ 网络 ============
export interface ServiceRow {
  name: string;
  namespace: string;
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  clusterIP: string;
  ports: string;
  status: StatusKind;
}
export const services: ServiceRow[] = [
  { name: "payment-svc", namespace: "ns-payment", type: "ClusterIP", clusterIP: "10.96.12.31", ports: "8080:8080/TCP", status: "ok" },
  { name: "order-svc", namespace: "ns-order", type: "ClusterIP", clusterIP: "10.96.12.42", ports: "8080:8080/TCP", status: "ok" },
  { name: "gateway-lb", namespace: "ns-gateway", type: "LoadBalancer", clusterIP: "10.96.13.10", ports: "80:30080/TCP,443:30443/TCP", status: "ok" },
  { name: "grafana-svc", namespace: "ns-monitor", type: "NodePort", clusterIP: "10.96.14.5", ports: "3000:30300/TCP", status: "ok" },
  { name: "es-svc", namespace: "ns-monitor", type: "ClusterIP", clusterIP: "10.96.14.18", ports: "9200:9200/TCP", status: "warn" },
  { name: "ai-infer-lb", namespace: "ns-ai-train", type: "LoadBalancer", clusterIP: "10.96.15.2", ports: "8000:30800/TCP", status: "err" },
];

export interface IngressRow {
  host: string;
  path: string;
  backend: string;
  tls: boolean;
  status: StatusKind;
}
export const ingresses: IngressRow[] = [
  { host: "pay.example.com", path: "/", backend: "payment-svc:8080", tls: true, status: "ok" },
  { host: "order.example.com", path: "/api", backend: "order-svc:8080", tls: true, status: "ok" },
  { host: "console.example.com", path: "/", backend: "gateway-lb:80", tls: true, status: "ok" },
  { host: "grafana.example.com", path: "/", backend: "grafana-svc:3000", tls: true, status: "ok" },
  { host: "ai.example.com", path: "/v1", backend: "ai-infer-lb:8000", tls: false, status: "err" },
];

export const networkSummary = {
  services: 86, ingresses: 14, loadBalancers: 9, networkPolicies: 23, dns: "CoreDNS",
};

// ============ 平台治理 · 企业空间 ============
export interface Workspace {
  name: string;
  admin: string;
  projects: number;
  members: number;
  quotaCpu: number; // used percent
  quotaMem: number;
  status: StatusKind;
}
export const workspaces: Workspace[] = [
  { name: "ws-payment", admin: "张伟", projects: 6, members: 18, quotaCpu: 58, quotaMem: 64, status: "ok" },
  { name: "ws-order", admin: "李娜", projects: 5, members: 14, quotaCpu: 43, quotaMem: 51, status: "ok" },
  { name: "ws-gateway", admin: "王强", projects: 3, members: 9, quotaCpu: 88, quotaMem: 60, status: "warn" },
  { name: "ws-ai", admin: "陈晨", projects: 4, members: 12, quotaCpu: 91, quotaMem: 79, status: "warn" },
  { name: "ws-monitor", admin: "刘洋", projects: 2, members: 6, quotaCpu: 34, quotaMem: 47, status: "ok" },
  { name: "ws-edu", admin: "赵敏", projects: 1, members: 3, quotaCpu: 12, quotaMem: 18, status: "idle" },
];

// ============ 平台治理 · 用户与角色 ============
export interface UserRow {
  name: string;
  role: "平台管理员" | "空间管理员" | "开发者" | "访客";
  email: string;
  status: StatusKind;
  lastLogin: string;
}
export const users: UserRow[] = [
  { name: "思敏", role: "平台管理员", email: "simin@dunhelm.io", status: "ok", lastLogin: "16:40" },
  { name: "张伟", role: "空间管理员", email: "zhangwei@dunhelm.io", status: "ok", lastLogin: "15:22" },
  { name: "李娜", role: "空间管理员", email: "lina@dunhelm.io", status: "ok", lastLogin: "14:05" },
  { name: "王强", role: "开发者", email: "wangqiang@dunhelm.io", status: "ok", lastLogin: "11:48" },
  { name: "陈晨", role: "开发者", email: "chenchen@dunhelm.io", status: "warn", lastLogin: "3d前" },
  { name: "赵敏", role: "访客", email: "zhaomin@dunhelm.io", status: "idle", lastLogin: "12d前" },
  { name: "周杰", role: "开发者", email: "zhoujie@dunhelm.io", status: "ok", lastLogin: "09:31" },
  { name: "吴磊", role: "访客", email: "wulei@dunhelm.io", status: "err", lastLogin: "—" },
];
export const roleSummary = [
  { role: "平台管理员", count: 1, color: "bg-brand-500" },
  { role: "空间管理员", count: 3, color: "bg-cyan-500" },
  { role: "开发者", count: 12, color: "bg-ok" },
  { role: "访客", count: 5, color: "bg-idle" },
];

// ============ 平台治理 · 审计日志 ============
export interface AuditLog {
  time: string;
  action: string;
  user: string;
  resource: string;
  result: "ok" | "err";
}
export const auditLogs: AuditLog[] = [
  { time: "16:42", action: "创建 Deployment", user: "王强", resource: "ns-gateway/gateway-envoy", result: "ok" },
  { time: "16:38", action: "推送镜像", user: "CI Bot", resource: "registry.local/payment:1.8.2", result: "ok" },
  { time: "16:31", action: "扩缩容", user: "李娜", resource: "gateway-hpa", result: "ok" },
  { time: "16:28", action: "删除 PVC", user: "吴磊", resource: "ns-order/data-tmp", result: "err" },
  { time: "16:11", action: "修改角色绑定", user: "思敏", resource: "ws-ai/developer", result: "ok" },
  { time: "15:55", action: "触发流水线", user: "CI Bot", resource: "infra/envoy", result: "ok" },
  { time: "15:30", action: "登录控制台", user: "周杰", resource: "auth/login", result: "ok" },
  { time: "15:02", action: "创建企业空间", user: "思敏", resource: "ws-edu", result: "ok" },
  { time: "14:40", action: "删除命名空间", user: "赵敏", resource: "ns-test", result: "err" },
  { time: "14:18", action: "绑定 Ingress", user: "王强", resource: "ai.example.com", result: "ok" },
];
export const auditSummary = { total: 1284, today: 36, denied: 5, sensitive: 12 };

// ============ 工作负载 · Job / CronJob ============
export interface JobRow {
  name: string;
  namespace: string;
  status: StatusKind;
  completions: number; // 已完成数
  parallelism: number; // 并行数
  duration: string; // 耗时 / 活跃时长
  image: string;
  age: string;
  schedule?: string; // 仅 CronJob
  active?: number; // 仅 CronJob：活跃实例
  lastSchedule?: string; // 仅 CronJob
  nextSchedule?: string; // 仅 CronJob
}

export const jobs: JobRow[] = [
  { name: "data-migrate-2841", namespace: "ns-order", status: "ok", completions: 1, parallelism: 1, duration: "3m48s", image: "registry.local/migrate:0.6.1", age: "2h" },
  { name: "report-gen-daily", namespace: "ns-payment", status: "ok", completions: 1, parallelism: 2, duration: "11m02s", image: "registry.local/report:2.0", age: "8h" },
  { name: "es-snapshot", namespace: "ns-monitor", status: "ok", completions: 1, parallelism: 1, duration: "6m30s", image: "registry.local/es-snapshot:1.4", age: "1d" },
  { name: "ai-train-eval", namespace: "ns-ai-train", status: "err", completions: 0, parallelism: 4, duration: "2m10s", image: "registry.local/eval:0.9.1", age: "5m" },
  { name: "cache-warmup", namespace: "ns-gateway", status: "running", completions: 0, parallelism: 3, duration: "1m12s", image: "registry.local/warmup:1.1", age: "1m" },
];

export const cronjobs: JobRow[] = [
  { name: "backup-mysql", namespace: "ns-payment", status: "ok", completions: 1, parallelism: 1, duration: "4m", image: "registry.local/xtrabackup:8.0", age: "12h", schedule: "0 2 * * *", active: 0, lastSchedule: "02:00", nextSchedule: "明日 02:00" },
  { name: "log-rotate", namespace: "ns-order", status: "ok", completions: 1, parallelism: 1, duration: "45s", image: "registry.local/logrotate:1.0", age: "6h", schedule: "*/30 * * * *", active: 0, lastSchedule: "16:30", nextSchedule: "16:50" },
  { name: "metrics-collect", namespace: "ns-monitor", status: "ok", completions: 1, parallelism: 1, duration: "1m20s", image: "registry.local/collector:3.2", age: "20m", schedule: "*/15 * * * *", active: 1, lastSchedule: "16:45", nextSchedule: "17:00" },
  { name: "cert-renew", namespace: "kube-system", status: "warn", completions: 0, parallelism: 1, duration: "—", image: "registry.local/certbot:2.9", age: "5d", schedule: "0 0 1 * *", active: 0, lastSchedule: "7-01", nextSchedule: "9-01" },
];

// ============ 代码凭证 ============
export interface Credential {
  name: string;
  type: "GitHub" | "GitLab" | "Gitee" | "Harbor" | "Docker Hub" | "SSH" | "KubeConfig" | "TLS";
  scope: "全局" | "企业空间" | "项目" | string;
  secretRef: string;
  createdBy: string;
  lastUsed: string;
  status: StatusKind;
  /** 真实集群 Secret 才带命名空间；DB 演示数据为空 */
  namespace?: string;
}

/** 创建凭证请求体（落到真实集群 K8s Secret 或本地 DB） */
export interface CredentialInput {
  name: string;
  namespace?: string;
  type: Credential["type"];
  scope?: string;
  /** 按 type 解释：git→{token}; 镜像→{username,password,registry?}; ssh→{privateKey}; kubeconfig→{kubeconfig}; tls→{cert,key} */
  data?: Record<string, string>;
  createdBy?: string;
}

export const credentials: Credential[] = [
  { name: "github-platform", type: "GitHub", scope: "全局", secretRef: "gh-token-2f9a", createdBy: "思敏", lastUsed: "16:38", status: "ok" },
  { name: "gitlab-internal", type: "GitLab", scope: "企业空间", secretRef: "gl-token-7c1d", createdBy: "张伟", lastUsed: "15:22", status: "ok" },
  { name: "harbor-push", type: "Harbor", scope: "全局", secretRef: "harbor-rw-4b8e", createdBy: "思敏", lastUsed: "16:40", status: "ok" },
  { name: "gitee-mirror", type: "Gitee", scope: "项目", secretRef: "gte-token-1a3f", createdBy: "李娜", lastUsed: "2d前", status: "idle" },
  { name: "ssh-deploy-key", type: "SSH", scope: "项目", secretRef: "ssh-rsa-9e02", createdBy: "王强", lastUsed: "11:48", status: "ok" },
  { name: "dockerhub-pull", type: "Docker Hub", scope: "全局", secretRef: "dh-token-5d6c", createdBy: "陈晨", lastUsed: "3d前", status: "warn" },
  { name: "kubeconfig-admin", type: "KubeConfig", scope: "全局", secretRef: "kube-admin-0a7b", createdBy: "思敏", lastUsed: "09:31", status: "ok" },
];

