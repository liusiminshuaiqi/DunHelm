// 轻量 API 客户端：所有请求走 /api（由 vite dev server 代理到后端 8088）
//
// 鉴权：后端除 /health、/login 外全部要求 JWT。前端登录后把 token 与当前用户
// 持久化到 localStorage；未登录时任何数据请求都会触发「跳登录页」（由 App 监听
// onAuthChange 实现）。401 表示令牌失效，统一清空并回到登录页。

import { getCluster } from "@/lib/cluster";

const TOKEN_KEY = "dunhelm.token";
const USER_KEY = "dunhelm.user";

export interface AuthUser {
  username: string;
  role: string;
  uid: number;
}

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* 忽略写入失败 */ }
}
function safeDel(k: string) {
  try { localStorage.removeItem(k); } catch { /* 忽略 */ }
}

let authToken: string | null = safeGet(TOKEN_KEY);
let authUser: AuthUser | null = (() => {
  const raw = safeGet(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as AuthUser; } catch { return null; }
})();

type AuthListener = (user: AuthUser | null) => void;
const authListeners = new Set<AuthListener>();
export function onAuthChange(cb: AuthListener): () => void {
  authListeners.add(cb);
  return () => { authListeners.delete(cb); };
}
function emitAuth() {
  for (const cb of authListeners) cb(authUser);
}

export function getCurrentUser(): AuthUser | null {
  return authUser;
}
export function isLoggedIn(): boolean {
  return !!authToken;
}

// login 以用户名 + 密码换取 JWT，成功后持久化并广播登录态变化（App 据此渲染主界面）
export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let msg = "登录失败";
    try {
      const d = await res.json();
      if (d && typeof d.error === "string" && d.error) msg = d.error;
    } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  const d = (await res.json()) as { token: string; username: string; role: string; uid: number };
  authToken = d.token;
  authUser = { username: d.username, role: d.role, uid: d.uid };
  safeSet(TOKEN_KEY, d.token);
  safeSet(USER_KEY, JSON.stringify(authUser));
  emitAuth();
  return authUser;
}

// logout 清空登录态并广播（App 据此回到登录页）
export function logout(): void {
  authToken = null;
  authUser = null;
  safeDel(TOKEN_KEY);
  safeDel(USER_KEY);
  emitAuth();
}

function ensureToken(): string {
  if (authToken) return authToken;
  throw new Error("NOT_AUTHENTICATED");
}

// ApiError 在抛出的 Error 上保留 HTTP status，供调用方做 403/无权限等精准判断
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  let token: string;
  try {
    token = ensureToken();
  } catch {
    // 未登录：清空并触发登录页
    logout();
    throw new Error("NOT_AUTHENTICATED");
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // 令牌失效：清空并跳登录页（不再自动免密重试）
    logout();
    throw new Error("NOT_AUTHENTICATED");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string" && j.error) msg = j.error;
    } catch {
      /* 响应体非 JSON 时退回状态码 */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

// withCluster：自动拼接当前选中集群 id（?cluster=），使 DevOps 类接口按集群隔离数据。
// 未选择集群时返回原 path（由后端 clusterID 兜底到第一个集群，避免前端传参遗漏）。
function withCluster(path: string): string {
  const id = getCluster();
  if (!id) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}cluster=${encodeURIComponent(id)}`;
}

export function apiGet<T>(path: string): Promise<T> {
  return authed<T>("GET", path);
}

export function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  return authed<T>(method, path, body);
}

// 供日志流(fetch)与控制台(WebSocket)等非 JSON 接口复用已缓存的 JWT
export async function getAuthToken(): Promise<string> {
  return ensureToken();
}

// ---------- 工作负载写操作（暂停/重启/升级/回滚，作用于真实集群）----------

export interface RevisionInfo {
  revision: number;
  image: string;
  age: string;
  current: boolean;
}

// 发布历史 + Deployment 暂停状态（供回滚弹窗与暂停按钮文案）
export function workloadRevisions(cluster: string, ns: string, name: string, kind: string) {
  return apiGet<{ revisions: RevisionInfo[]; paused: boolean }>(
    `/workload-revisions?cluster=${encodeURIComponent(cluster)}&ns=${encodeURIComponent(ns)}&name=${encodeURIComponent(name)}&kind=${encodeURIComponent(kind)}`,
  );
}

// 执行写操作：action ∈ pause|resume|restart|upgrade|rollback；payload 携带 containers / revision
export function workloadAction(params: {
  cluster: string;
  ns: string;
  name: string;
  kind: string;
  action: string;
  payload?: Record<string, unknown>;
}) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/workload-action?cluster=${encodeURIComponent(params.cluster)}`,
    params,
  );
}

// ---------- 工作负载创建（含 probes / volumes） ----------
export interface ProbeParam {
  type?: string;
  path?: string;
  port?: number | string;
  scheme?: string;
  command?: string[];
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}
export interface VolumeParam {
  name?: string;
  type?: string;
  claim?: string;
  sizeLimit?: string;
  path?: string;
  hostPathType?: string;
  refName?: string;
  mountPath?: string;
  subPath?: string;
  readOnly?: boolean;
}
export interface PortParam {
  name?: string;
  containerPort: number;
  protocol?: string;
  hostPort?: number;
}
export interface CreateWorkloadParams {
  cluster: string;
  kind: string;
  name: string;
  namespace: string;
  replicas: number;
  image: string;
  cpu?: string;
  mem?: string;
  cpuReq?: string;
  memReq?: string;
  schedule?: string;
  ports?: PortParam[];
  env?: { name: string; value: string }[];
  command?: string[];
  args?: string[];
  livenessProbe?: ProbeParam;
  readinessProbe?: ProbeParam;
  startupProbe?: ProbeParam;
  volumes?: VolumeParam[];
}
export function createWorkload(params: CreateWorkloadParams) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/workloads?cluster=${encodeURIComponent(params.cluster)}`,
    params,
  );
}

// ---------- 工作负载编辑（副本/资源/端口/探活/命令/生命周期）+ live YAML ----------
export interface LifecycleHandlerParam {
  type?: string;
  command?: string[];
  path?: string;
  port?: number | string;
  scheme?: string;
}
export interface LifecycleParam {
  postStart?: LifecycleHandlerParam;
  preStop?: LifecycleHandlerParam;
}
export interface EditableContainer {
  name: string;
  image?: string;
  cpu?: string;
  mem?: string;
  cpuReq?: string;
  memReq?: string;
  ports?: { name?: string; containerPort: number; protocol?: string; hostPort?: number }[];
  env?: { name: string; value: string }[];
  command?: string[];
  args?: string[];
  livenessProbe?: ProbeParam;
  readinessProbe?: ProbeParam;
  startupProbe?: ProbeParam;
  lifecycle?: LifecycleParam;
}
export interface EditableSpec {
  kind?: string;
  replicas?: number;
  container: EditableContainer;
}
export function getWorkloadSpec(cluster: string, ns: string, name: string, kind: string) {
  return apiGet<EditableSpec>(
    `/workloads/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}&kind=${encodeURIComponent(kind)}`,
  );
}
export function updateWorkload(cluster: string, ns: string, name: string, kind: string, spec: EditableSpec) {
  return apiSend<{ ok: boolean }>(
    "PUT",
    `/workloads/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}&kind=${encodeURIComponent(kind)}`,
    spec,
  );
}
export function getWorkloadYaml(cluster: string, ns: string, name: string, kind: string) {
  return apiGet<{ yaml: string }>(
    `/workloads/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/yaml?cluster=${encodeURIComponent(cluster)}&kind=${encodeURIComponent(kind)}`,
  );
}

// ---------- 工作负载 + Pod + 日志 + 控制台（运行时） ----------
export interface NodePod {
  name: string;
  namespace: string;
  status: string;
  containers: { name: string; image: string; ready: boolean }[];
  restarts: number;
  ownerKind: string;
  ownerName: string;
  podIP: string;
  age: string;
}
export function nodePods(cluster: string, node: string) {
  return apiGet<{ pods: NodePod[] }>(
    `/node-pods?cluster=${encodeURIComponent(cluster)}&node=${encodeURIComponent(node)}`,
  );
}

// ---------- node-exporter / metrics-server 一键安装 ----------
export interface NodeExporterStatus {
  installed: boolean;
  ready: boolean;
  message: string;
  pods: { node: string; phase: string; reason: string }[];
}
export function nodeExporterStatus(cluster: string) {
  return apiGet<NodeExporterStatus>(
    `/node-exporter/status?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function nodeExporterInstall(cluster: string) {
  return apiSend<{ ok: boolean; message: string }>(
    "POST",
    `/node-exporter/install?cluster=${encodeURIComponent(cluster)}`,
  );
}
export interface MetricsServerStatus {
  installed: boolean;
  ready: boolean;
  message: string;
}
export function metricsServerStatus(cluster: string) {
  return apiGet<MetricsServerStatus>(
    `/metrics-server/status?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function metricsServerInstall(cluster: string) {
  return apiSend<{ ok: boolean; message: string }>(
    "POST",
    `/metrics-server/install?cluster=${encodeURIComponent(cluster)}`,
  );
}

// ---------- 集群 CRUD ----------
export interface ClusterInput {
  name: string;
  version?: string;
  provider?: string;
  region?: string;
  kubeConfig: string;
  context?: string;
}
export function createCluster(body: ClusterInput) {
  return apiSend<{ id: number }>("POST", "/clusters", body);
}
export function deleteCluster(id: number) {
  return apiSend<{ ok: boolean }>("DELETE", `/clusters/${id}`);
}

// ---------- 凭证 ----------
export interface CredentialInput {
  name: string;
  type: string;
  username?: string;
  password?: string;
  sshKey?: string;
  kubeConfig?: string;
  host?: string;
  namespace?: string;
  cluster?: string;
}
export function createCredential(cluster: string, body: CredentialInput) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/credentials?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function deleteCredential(cluster: string, ns: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/credentials?cluster=${encodeURIComponent(cluster)}&namespace=${encodeURIComponent(ns)}&name=${encodeURIComponent(name)}`,
  );
}
export function deleteCredentialDB(id: number) {
  return apiSend<{ ok: boolean }>("DELETE", `/credentials/${id}`);
}

// ---------- 网络 ----------
export interface ServicePortInput {
  port: number;
  targetPort: number;
  protocol?: string;
  name?: string;
}
export interface CreateServiceInput {
  name: string;
  namespace: string;
  type?: string;
  selector?: Record<string, string> | string;
  annotations?: Record<string, string>;
  ports: ServicePortInput[];
}
export interface UpdateServiceInput {
  type?: string;
  selector?: Record<string, string> | string;
  annotations?: Record<string, string>;
  ports?: ServicePortInput[];
}
export interface CreateIngressInput {
  namespace: string;
  host: string;
  path?: string;
  backend: string;
  tls?: boolean;
  secretName?: string;
}
export interface UpdateIngressInput {
  path?: string;
  backend?: string;
  tls?: boolean;
  secretName?: string;
}
export function createService(cluster: string, body: CreateServiceInput) {
  return apiSend<{ ok: boolean; name: string }>(
    "POST",
    `/services?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function updateService(cluster: string, ns: string, name: string, body: UpdateServiceInput) {
  return apiSend<{ ok: boolean; name: string }>(
    "PUT",
    `/services/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function deleteService(cluster: string, ns: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/services/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function createIngress(cluster: string, body: CreateIngressInput) {
  return apiSend<{ ok: boolean; name: string }>(
    "POST",
    `/ingresses?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function updateIngress(cluster: string, ns: string, name: string, body: UpdateIngressInput) {
  return apiSend<{ ok: boolean; name: string }>(
    "PUT",
    `/ingresses/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function deleteIngress(cluster: string, ns: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/ingresses/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function generateIngressCert(cluster: string, host: string, ns: string) {
  return apiSend<{ ok: boolean; secretName: string }>(
    "POST",
    `/ingresses/tls-cert?cluster=${encodeURIComponent(cluster)}&host=${encodeURIComponent(host)}&namespace=${encodeURIComponent(ns)}`,
  );
}

// ---------- 存储 ----------
export interface StorageClassDetailResp {
  storageClass: {
    name: string;
    provisioner: string;
    reclaim: string;
    bindMode: string;
    allowVolumeExpansion: boolean;
    volumes?: number | string;
    isDefault: boolean;
    age: string;
  };
  parameters: Record<string, string>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  yaml: string;
}
export interface PVDetailResp {
  persistentVolume: {
    name: string;
    capacity: string;
    accessModes: string[];
    storageClass: string;
    reclaimPolicy: string;
    phase: string;
    claim?: string;
    annotations: Record<string, string>;
    age: string;
    source?: Record<string, unknown>;
  };
  sourceRaw: Record<string, unknown>;
  yaml: string;
}
export interface PVCDetailResp {
  pvc: {
    name: string;
    namespace: string;
    status: string;
    capacity: string;
    requested: string;
    storageClass: string;
    accessModes: string[];
    access?: string;
    volume?: string;
    age: string;
  };
  yaml: string;
}
export interface PVCreateInput {
  name: string;
  capacity: string;
  accessModes: string[];
  storageClass: string;
  reclaimPolicy: string;
  sourceType: string;
  sourceHostPath?: string;
  sourceNFSServer?: string;
  sourceNFSPath?: string;
  sourceLocalPath?: string;
  sourceLocalNode?: string;
  sourceCSIDriver?: string;
  sourceCSIVolumeHandle?: string;
  sourceCSIFSType?: string;
}
export function storageClassDetail(cluster: string, name: string) {
  return apiGet<StorageClassDetailResp>(
    `/storage-classes/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function updateStorageClass(cluster: string, name: string, body: Record<string, unknown>) {
  return apiSend<StorageClassDetailResp>(
    "PUT",
    `/storage-classes/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function deleteStorageClass(cluster: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/storage-classes/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function createStorageClass(cluster: string, body: Record<string, unknown>) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/storage-classes?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function pvDetail(cluster: string, name: string) {
  return apiGet<PVDetailResp>(
    `/pvs/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function updatePV(cluster: string, name: string, body: Record<string, unknown>) {
  return apiSend<PVDetailResp>(
    "PUT",
    `/pvs/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function deletePV(cluster: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/pvs/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function createPV(cluster: string, body: PVCreateInput) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/pvs?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function pvcDetail(cluster: string, ns: string, name: string) {
  return apiGet<PVCDetailResp>(
    `/pvcs/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function updatePVC(cluster: string, ns: string, name: string, body: Record<string, unknown>) {
  return apiSend<PVCDetailResp>(
    "PUT",
    `/pvcs/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}
export function deletePVC(cluster: string, ns: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/pvcs/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?cluster=${encodeURIComponent(cluster)}`,
  );
}
export function createPVC(cluster: string, body: Record<string, unknown>) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/pvcs?cluster=${encodeURIComponent(cluster)}`,
    body,
  );
}

// ---------- 镜像仓库（多注册中心连接 + Harbor 真实对接） ----------
export interface RegistryConn {
  id?: number;
  name: string;
  type: string;          // harbor / dockerhub / acr
  url: string;
  username?: string;
  password?: string;     // 创建/更新时下发；后端返回时解密明文
  namespace?: string;
  insecureTls?: boolean;
  /** 编辑/查看用：表单中非空字符串 */
  insecureTlsStr?: string;
}
export interface RegistryProject {
  id: number;
  name: string;
  public: boolean;
  repoCount: number;
  quotaUsed?: number;
}
export interface RegistryRepo {
  name: string;
  repo?: string;          // 兼容：镜像仓库面板展示用「纯仓库名」（去掉前缀）
  artifactCount: number;
  pullCount?: number;
}
export interface VulnSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}
export interface RegistryArtifactTag {
  name: string;
  pushTime?: string;
  size?: string;
  digest?: string;
}
export interface RegistryArtifact {
  name: string;
  size: string;
  pushed: string;
  pushTime?: string;
  digest?: string;
  vuln?: VulnSummary;
  tags?: RegistryArtifactTag[];
}
export function listRegistries() {
  return apiGet<RegistryConn[]>(withCluster("/registries"));
}
export function createRegistry(body: Partial<RegistryConn>) {
  return apiSend<RegistryConn>("POST", withCluster("/registries"), body);
}
export function updateRegistry(id: number | undefined, body: Partial<RegistryConn>) {
  return apiSend<RegistryConn>("PUT", withCluster(`/registries/${id}`), body);
}
export function deleteRegistry(id: number) {
  return apiSend<{ ok: boolean }>("DELETE", withCluster(`/registries/${id}`));
}
export function testRegistry(body: Partial<RegistryConn> & { id?: number }) {
  return apiSend<{ ok: boolean; latencyMs?: number; error?: string }>(
    "POST",
    "/registries/test",
    body,
  );
}
export function registryProjects(registryId: string) {
  return apiGet<RegistryProject[]>(
    `/registry/projects?registry=${encodeURIComponent(registryId)}`,
  );
}
export function createRegistryProject(registryId: string, body: { name: string; public: boolean }) {
  return apiSend<{ ok: boolean }>(
    "POST",
    `/registry/projects?registry=${encodeURIComponent(registryId)}`,
    body,
  );
}
export function updateRegistryProject(registryId: string, name: string, pub: boolean) {
  return apiSend<{ ok: boolean }>(
    "PUT",
    `/registry/projects?registry=${encodeURIComponent(registryId)}`,
    { name, public: pub },
  );
}
export function deleteRegistryProject(registryId: string, name: string) {
  return apiSend<{ ok: boolean }>(
    "DELETE",
    `/registry/projects?registry=${encodeURIComponent(registryId)}&name=${encodeURIComponent(name)}`,
  );
}
export function registryRepos(registryId: string, project: string) {
  return apiGet<RegistryRepo[]>(
    `/registry/repos?registry=${encodeURIComponent(registryId)}&project=${encodeURIComponent(project)}`,
  );
}
export function registryArtifacts(registryId: string, project: string, repo: string) {
  return apiGet<RegistryArtifact[]>(
    `/registry/artifacts?registry=${encodeURIComponent(registryId)}&project=${encodeURIComponent(project)}&repo=${encodeURIComponent(repo)}`,
  );
}
export function registryProjectUsage(registryId: string, project: string) {
  return apiGet<{ usedBytes: number; artifactCount: number }>(
    `/registry/project-usage?registry=${encodeURIComponent(registryId)}&project=${encodeURIComponent(project)}`,
  );
}
export function deleteRegistryArtifact(registryId: string, project: string, repo: string, ref: string) {
  return apiSend<{ code: number }>(
    "DELETE",
    `/registry/artifacts?registry=${encodeURIComponent(registryId)}&project=${encodeURIComponent(project)}&repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`,
  );
}
export function deleteRegistryRepository(registryId: string, project: string, repo: string) {
  return apiSend<{ code: number; project: string; repo: string }>(
    "DELETE",
    `/registry/repositories?registry=${encodeURIComponent(registryId)}&project=${encodeURIComponent(project)}&repo=${encodeURIComponent(repo)}`,
  );
}

// ---------- 流水线（自研 CI 引擎） ----------
export interface PipelineStage {
  name: string;
  status?: string;
}
// 单次构建的阶段运行态（含 console 日志与时间戳）
export interface BuildStageRun {
  name: string;
  status: string;
  log?: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface PipelineRow {
  name: string;
  repo: string;
  branch: string;
  lastStatus: "ok" | "running" | "err" | "aborted" | string;
  duration: string;
  trigger: string;
  env?: string;
  lastRun: string;
  stages: PipelineStage[];
  spark: number[];
  /** 最近 N 次构建状态（最新在前；ok/err/running/aborted）。来自后端 Pipelines 列表接口运行时填充，供卡片上的构建历史条按状态填色 */
  recentBuilds?: string[];
  triggerMode?: PipelineTriggerMode;
  defaultImage?: string;
  targetNamespace?: string;
  targetWorkload?: string;
  cluster?: string;
  /** 容器运行时：docker（默认，需 docker daemon）/ podman（daemonless，适合 K8s Pod 内 build/push） */
  runtime?: string;
  /** 构建模版：maven（后端，~/.m2 缓存）/ npm（前端，cacache 缓存）。空等同 maven */
  builderType?: string;
  /** 流水级 Maven 配置（settings.xml 全文，含 servers/凭证）。构建时挂到 /root/.m2/settings.xml */
  mavenSettings?: string;
  /** 公共模板标记：true 时该流水线可被其他集群读取（读路径回退），但写操作仍限本集群 */
  isTemplate?: boolean;
}
export interface BuildRow {
  id: string;
  pipeline: string;
  status: "ok" | "running" | "err" | "aborted" | string;
  branch: string;
  trigger: string;
  duration: string;
  time: string;
  stages?: BuildStageRun[];
  source?: BuildSource;
}
// 构建记录分页响应
export interface BuildListResp {
  list: BuildRow[];
  total: number;
  page: number;
  pageSize: number;
}
// 构建记录保留条数（平台级全局配置）
export interface BuildRetentionResp {
  keep: number;
}
export interface PipelineDetailResp {
  pipeline: PipelineRow;
  builds: BuildRow[];
}

// 流水线节点种类（决定画布节点颜色与引擎阶段归类）
export type PipelineNodeKind =
  | "git"      // 拉取代码
  | "build"    // 编译
  | "test"     // 测试
  | "image"    // 已有镜像（引用）
  | "docker-build" // 用 Dockerfile 构建镜像（仅构建，不推送）
  | "push"     // 推送镜像（复用上游构建的镜像）
  | "backend"  // 上传后端编译包
  | "frontend" // 上传前端静态包
  | "deploy"   // 部署
  | "configmap" // 配置管理：读取 / 编辑集群里的 ConfigMap
  | "notify"   // 告警/通知
  | "wait"     // 等待
  | "custom";  // 自定义

// 流水线阶段定义（节点）：name / enabled 标志 / 节点类型
export interface PipelineStageDef {
  name: string;
  enabled: boolean;
  kind?: PipelineNodeKind;
  desc?: string;
  /** 并行任务标记：值为同一 group 内主线 stage 的 name，空=主线 */
  parallelOf?: string;
  /** kind 相关的配置（JSON 字符串），如 git 仓库/分支、image 镜像、deploy 命名空间/工作负载、notify webhook、upload artifactPath 等 */
  config?: string;
}
// 触发模式：git / backend / frontend / image（空 = git）
export type PipelineTriggerMode = "git" | "backend" | "frontend" | "image" | "";

// 流水线配置（创建/编辑时使用）
export interface PipelineConfig {
  name: string;
  repo: string;
  branch: string;
  trigger: string;
  env: string;
  triggerMode?: PipelineTriggerMode;
  defaultImage?: string;
  targetNamespace?: string;
  targetWorkload?: string;
  /** 构建集群（clusterID 字符串，留空用首个 Connected 集群）；统一在流水线基础信息配置 */
  cluster?: string;
  /** 容器运行时：docker（默认）/ podman（daemonless，适合 K8s Pod 内 build/push） */
  runtime?: string;
  /** 构建模版（决定构建 Pod 的本地依赖缓存挂载方式）：maven（后端，~/.m2）/ npm（前端，npm cacache）。空等同 maven */
  builderType?: string;
  /** 流水级 Maven 配置（settings.xml 全文，含 servers/凭证）。构建时挂到 /root/.m2/settings.xml */
  mavenSettings?: string;
  /** 公共模板标记：true 时该流水线可被其他集群读取 */
  isTemplate?: boolean;
  stages: PipelineStageDef[];
}

// 单次构建的源信息
export interface BuildSource {
  triggerMode: PipelineTriggerMode;
  branch: string;
  image?: string;
  repo?: string;
  namespace?: string;
  workload?: string;
  artifactPath?: string;
  frontendPath?: string;
}

// 创建流水线（自定义阶段 + 触发模式 + 镜像/包/前端/仓库配置）
export function createPipeline(body: PipelineConfig) {
  return apiSend<{ ok: boolean; name: string }>("POST", withCluster("/pipelines"), body);
}

// 获取流水线详情（配置 + 该流水线的构建历史）
export function getPipelineDetail(name: string) {
  return apiGet<PipelineDetailResp>(
    withCluster(`/pipelines/${encodeURIComponent(name)}`),
  );
}

// 编辑流水线（基础信息 + 阶段 + 触发源）
export function updatePipeline(name: string, body: PipelineConfig) {
  return apiSend<{ ok: boolean; name: string }>(
    "PUT",
    withCluster(`/pipelines/${encodeURIComponent(name)}`),
    body,
  );
}

// 仅更新阶段列表（详情页内联编辑：增删/启用关闭/重排序）
export function updatePipelineStages(name: string, stages: PipelineStageDef[]) {
  return apiSend<{ ok: boolean; name: string; stages: PipelineStageDef[] }>(
    "PATCH",
    withCluster(`/pipelines/${encodeURIComponent(name)}/stages`),
    { stages },
  );
}

// 仅更新触发源（triggerMode / defaultImage / namespace / workload / repo / branch）
export function setPipelineSource(name: string, body: Partial<{
  triggerMode: PipelineTriggerMode;
  defaultImage: string;
  targetNamespace: string;
  targetWorkload: string;
  repo: string;
  branch: string;
}>) {
  return apiSend<{ ok: boolean; name: string }>(
    "PATCH",
    withCluster(`/pipelines/${encodeURIComponent(name)}/source`),
    body,
  );
}

// 删除流水线（级联清理其构建记录）
export function deletePipeline(name: string) {
  return apiSend<{ ok: boolean; name: string }>(
    "DELETE",
    withCluster(`/pipelines/${encodeURIComponent(name)}`),
  );
}

// 设置/取消公共模板标记（is_template）
export function setPipelineTemplate(name: string, isTemplate: boolean) {
  return apiSend<{ ok: boolean; name: string; isTemplate: boolean }>(
    "PUT",
    withCluster(`/pipelines/${encodeURIComponent(name)}/template`),
    { isTemplate },
  );
}

// ============ 用户与角色（RBAC） ============
export interface UserRow {
  id: number;
  name: string;
  role: string; // platform-admin / workspace-admin / developer / viewer
  email: string;
  status: string; // ok / pending / locked
  active: boolean;
  lastLogin: string;
  createdAt: string;
}
export interface RoleRow {
  slug: string;
  name: string;
  description: string;
  isSystem: boolean;
  sortOrder: number;
}
export interface UserClusterPermissionRow {
  userId: number;
  clusterId: number;
  roleSlug: string;
  namespacesJson: string;
  createdAt: string;
  updatedAt: string;
}

// Roles
export function listRoles() {
  return apiGet<RoleRow[]>("/roles");
}
export function createRole(body: { slug: string; name: string; description?: string; sortOrder?: number }) {
  return apiSend<RoleRow>("POST", "/roles", body);
}
export function updateRole(slug: string, body: { name?: string; description?: string }) {
  return apiSend<RoleRow>("PUT", `/roles/${encodeURIComponent(slug)}`, body);
}
export function deleteRole(slug: string) {
  return apiSend<{ ok: boolean }>("DELETE", `/roles/${encodeURIComponent(slug)}`);
}

// Users
export function listUsers() {
  return apiGet<UserRow[]>("/users");
}
export function getUser(id: number) {
  return apiGet<UserRow>(`/users/${id}`);
}
export function inviteUser(body: { name: string; email: string; role: string; password?: string }) {
  return apiSend<UserRow>("POST", "/users", body);
}
export function updateUser(id: number, body: { name?: string; email?: string; role?: string; password?: string }) {
  return apiSend<UserRow>("PUT", `/users/${id}`, body);
}
export function deleteUser(id: number) {
  return apiSend<{ ok: boolean }>("DELETE", `/users/${id}`);
}
export function setUserActive(id: number, active: boolean) {
  return apiSend<UserRow>("PATCH", `/users/${id}/active`, { active });
}
export function setUserStatus(id: number, status: string) {
  return apiSend<UserRow>("PATCH", `/users/${id}/status`, { status });
}
// resetUserPassword 管理员重置某用户密码（admin 专属接口）
export function resetUserPassword(id: number, password?: string) {
  return apiSend<{ ok: boolean }>("POST", `/users/${id}/password`, { password });
}

// User-Cluster Permissions
export function listUserPermissions(userId: number) {
  return apiGet<UserClusterPermissionRow[]>(`/users/${userId}/permissions`);
}
export function assignUserPermission(userId: number, body: { clusterId: number; roleSlug: string; namespaces?: string[] }) {
  return apiSend<UserClusterPermissionRow>("POST", `/users/${userId}/permissions`, body);
}
export function revokeUserPermission(userId: number, clusterId: number) {
  return apiSend<{ ok: boolean }>("DELETE", `/users/${userId}/permissions/${clusterId}`);
}

// 当前用户可用集群
export function myClusters() {
  return apiGet<{ clusters: Array<{ id: number; name: string; provider: string; region: string; connected: boolean }>; isPlatformAdmin: boolean }>("/clusters/me");
}

// ============ 菜单权限（RBAC） ============
// 全部菜单 key 常量（与后端 model.AllMenuKeys 对齐）
export const ALL_MENU_KEYS = [
  "overview", "workloads", "nodes", "storage", "network", "config",
  "pipelines", "buildconfig", "registry", "market", "credentials",
  "workspaces", "users", "audit", "clusters",
] as const;
export type MenuKey = typeof ALL_MENU_KEYS[number];
// 菜单 key → 中文显示名（前端渲染用）
export const MENU_LABEL: Record<string, string> = {
  overview: "集群总览",
  workloads: "工作负载",
  nodes: "集群节点",
  storage: "存储卷",
  network: "网络与存储",
  config: "配置 (ConfigMap)",
  pipelines: "流水线",
  buildconfig: "构建配置",
  registry: "镜像仓库",
  market: "应用商店",
  credentials: "代码凭证",
  workspaces: "企业空间",
  users: "用户与角色",
  audit: "审计日志",
  clusters: "集群管理",
};
// 菜单所属分组
export const MENU_GROUP: Record<string, string> = {
  overview: "概览",
  workloads: "资源", nodes: "资源", storage: "资源", network: "资源", config: "资源",
  pipelines: "DevOps", buildconfig: "DevOps", registry: "DevOps", market: "DevOps", credentials: "DevOps",
  workspaces: "平台治理", users: "平台治理", audit: "平台治理", clusters: "平台治理",
};

// 当前用户可见菜单
export function myMenus() {
  return apiGet<{ menus: string[]; isPlatformAdmin: boolean }>("/me/menus");
}
// 查/设某角色菜单权限（admin-only）
export function roleMenus(slug: string) {
  return apiGet<string[]>(`/roles/${encodeURIComponent(slug)}/menu-permissions`);
}
export function setRoleMenus(slug: string, menus: string[]) {
  return apiSend<{ ok: boolean; slug: string; menus: string[] }>("PUT", `/roles/${encodeURIComponent(slug)}/menu-permissions`, { menus });
}

// ============ 审计日志 ============
export interface AuditRow {
  id: number;
  time: string; // RFC3339Nano
  actorId: number;
  actorName: string;
  action: string;
  resourceType: string;
  resourceName: string;
  clusterId: number;
  result: string; // ok / denied / error
  detail: string;
  ip: string;
  userAgent: string;
}
export interface AuditSummary {
  total: number;
  today: number;
  denied: number;
  sensitive: number;
  topActors: Array<{ actorName: string; count: number }>;
  recentSensitive: AuditRow[];
}
export interface AuditQueryResp {
  items: AuditRow[];
  total: number;
}
// 多维筛选审计
export function listAudit(f: {
  actor?: string; action?: string; resourceType?: string; resource?: string;
  cluster?: number; result?: string; from?: string; to?: string;
  limit?: number; offset?: number;
} = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const qs = q.toString();
  return apiGet<AuditQueryResp>(`/audit${qs ? "?" + qs : ""}`);
}
export function getAuditSummary() {
  return apiGet<AuditSummary>("/audit/summary");
}
export function getAuditDetail(id: number) {
  return apiGet<AuditRow>(`/audit/${id}`);
}
// CSV/JSONL 导出（浏览器直接打开走 blob 下载）
export function exportAuditUrl(f: {
  actor?: string; action?: string; resourceType?: string; resource?: string;
  cluster?: number; result?: string; from?: string; to?: string; format?: "csv" | "json";
} = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== "" && k !== "format") q.set(k, String(v));
  }
  q.set("export", f.format ?? "csv");
  return `/api/audit?${q.toString()}`;
}

// 触发一次构建（多模式：git 默认；backend / frontend 需先上传；image 走镜像）
export function runPipeline(name: string, body: Partial<{
  triggerMode: PipelineTriggerMode;
  branch: string;
  image: string;
  repo: string;
  namespace: string;
  workload: string;
  artifactPath: string;
  frontendPath: string;
}> = {}) {
  return apiSend<{ ok: boolean; buildNo: string }>(
    "POST",
    withCluster(`/pipelines/${encodeURIComponent(name)}/run`),
    body,
  );
}

// 检测 Git 仓库连通性并列出分支（按鉴权方式：none / password / credential）。
export interface GitProbeResp {
  ok: boolean;
  branches: string[];
  error: string;
}
export function probeGitRepo(body: {
  repo: string;
  authMode: string;
  username?: string;
  password?: string;
  credential?: string;
}) {
  return apiSend<GitProbeResp>("POST", "/pipelines/git-probe", body);
}

// 上传后端包 / 前端包（multipart/form-data）。mode=backend|frontend
// 返回 { ok, name, mode, size, filename, savedAs, artifactPath | frontendPath }
export interface UploadResp {
  ok: boolean;
  name: string;
  mode: "backend" | "frontend";
  size: number;
  filename: string;
  savedAs: string;
  artifactPath?: string;
  frontendPath?: string;
}
export async function uploadPipelinePackage(
  name: string,
  mode: "backend" | "frontend",
  file: File,
  /** 关联到哪个 stage；缺省走兼容旧路由 */
  stageName?: string,
): Promise<UploadResp> {
  const token = await getAuthToken();
  const fd = new FormData();
  fd.append("mode", mode);
  fd.append("file", file);
  const base = stageName
    ? `/api/pipelines/${encodeURIComponent(name)}/stages/${encodeURIComponent(stageName)}/upload`
    : `/api/pipelines/${encodeURIComponent(name)}/upload`;
  const url = getCluster() ? `${base}?cluster=${encodeURIComponent(getCluster() as string)}` : base;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j && typeof j.error === "string" && j.error) msg = j.error;
    } catch {/* 非 JSON */}
    throw new Error(msg);
  }
  return (await r.json()) as UploadResp;
}

// 构建列表（可选按 pipeline 过滤；支持分页 page / pageSize）
export function listBuilds(opts?: { pipeline?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams();
  if (opts?.pipeline) params.set("pipeline", opts.pipeline);
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
  const qs = params.toString();
  return apiGet<BuildListResp>(withCluster(`/builds${qs ? "?" + qs : ""}`));
}

// 读取构建记录保留条数（平台级配置）
export function getBuildRetention() {
  return apiGet<BuildRetentionResp>("/settings/build-retention");
}

// 保存构建记录保留条数（1 起）
export function saveBuildRetention(keep: number) {
  return apiSend<{ ok: boolean; keep: number }>(
    "PUT",
    "/settings/build-retention",
    { keep },
  );
}

// 单个构建详情（含各阶段 console 日志）
export function getBuild(no: string) {
  return apiGet<BuildRow>(`/builds/${encodeURIComponent(no)}`);
}

// 中止运行中的构建
export function abortBuild(no: string) {
  return apiSend<{ ok: boolean; buildNo: string }>(
    "POST",
    `/builds/${encodeURIComponent(no)}/abort`,
  );
}

// ---------- 集群级 Maven 全局配置（mirror/proxy，按集群隔离，无密钥） ----------
export interface MavenGlobalSettings {
  /** 归属集群 id（?cluster 一致） */
  clusterId?: number;
  /** settings.xml 全文；未配置时为空串 */
  content: string;
  /** 最近更新时间（本地时间字符串） */
  updatedAt: string;
}
// 读取当前集群的 maven 全局配置（每个集群各自配置，构建挂载该集群的 settings）。
export function getMavenSettings() {
  return apiGet<MavenGlobalSettings>(withCluster("/maven-settings"));
}
// 保存/覆盖当前集群的 maven 全局配置。
export function saveMavenSettings(content: string) {
  return apiSend<{ ok: boolean }>("PUT", withCluster("/maven-settings"), { content });
}