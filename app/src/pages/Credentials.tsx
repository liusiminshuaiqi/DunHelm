import { useState } from "react";
import { Card, KpiStat, StatusBadge, SectionTitle, Modal, Field, TextInput, SelectInput, TextArea, ErrorBanner, PrimaryButton } from "@/components/ui/primitives";
import { type Credential, type CredentialInput } from "@/data/mock";
import { useCredentials, useNamespaces } from "@/data/useLive";
import { createCredential, deleteCredential, deleteCredentialDB } from "@/lib/api";
import { getCluster } from "@/lib/cluster";
import { cn } from "@/lib/utils";
import { KeyRound, Plus, Search, ShieldCheck, Trash2 } from "lucide-react";

const typeColor: Record<string, string> = {
  GitHub: "bg-brand-50 text-brand-600",
  GitLab: "bg-warn-bg text-warn",
  Gitee: "bg-ok-bg text-ok",
  Harbor: "bg-cyan-100 text-cyan-600",
  SSH: "bg-info-bg text-info",
  "Docker Hub": "bg-idle-bg text-idle",
  KubeConfig: "bg-brand-50 text-brand-700",
  TLS: "bg-brand-50 text-brand-600",
};

const scopeColor: Record<string, string> = {
  全局: "bg-brand-50 text-brand-600",
  "企业空间": "bg-cyan-100 text-cyan-600",
  项目: "bg-subtle text-ink-500",
};

const TYPE_OPTIONS = ["GitHub", "GitLab", "Gitee", "Harbor", "Docker Hub", "SSH", "KubeConfig", "TLS"] as const;

type FormState = {
  name: string;
  namespace: string;
  type: string;
  scope: string;
  token: string;
  username: string;
  password: string;
  registry: string;
  privateKey: string;
  kubeconfig: string;
  cert: string;
  key: string;
};

const emptyForm: FormState = {
  name: "", namespace: "default", type: "GitHub", scope: "全局",
  token: "", username: "", password: "", registry: "",
  privateKey: "", kubeconfig: "", cert: "", key: "",
};

function secretDisplay(c: Credential): string {
  if (c.namespace) return `${c.namespace}/${c.name}`;
  return c.secretRef;
}

export function Credentials() {
  const credentials = useCredentials() as unknown as Credential[] & { _error?: string; _permDenied?: boolean; _loading?: boolean; reload?: () => void };
  const list = Array.isArray(credentials) ? credentials : [];
  const err = credentials._error;
  const permDenied = credentials._permDenied;
  const loading = credentials._loading;
  const reload = credentials.reload ?? (() => {});
  const cid = getCluster();
  const namespaces = useNamespaces();

  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Credential | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [delConfirm, setDelConfirm] = useState(false);

  const set = (k: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const resetForm = () => { setForm(emptyForm); setSaveErr(""); };

  const save = async () => {
    if (!form.name) { setSaveErr("请填写凭证名称"); return; }
    const data: Record<string, string> = {};
    switch (form.type) {
      case "GitHub": case "GitLab": case "Gitee": data.token = form.token; break;
      case "Harbor": case "Docker Hub":
        data.username = form.username; data.password = form.password;
        if (form.registry) data.registry = form.registry;
        break;
      case "SSH": data.privateKey = form.privateKey; break;
      case "KubeConfig": data.kubeconfig = form.kubeconfig; break;
      case "TLS": data.cert = form.cert; data.key = form.key; break;
    }
    const body: CredentialInput = {
      name: form.name,
      namespace: form.namespace || "default",
      type: form.type as CredentialInput["type"],
      scope: form.scope,
      data,
      createdBy: "admin",
    };
    setSaving(true);
    setSaveErr("");
    try {
      await createCredential(cid, body);
      setOpen(false);
      resetForm();
      reload();
    } catch (e: any) {
      setSaveErr(e?.message || "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Credential) => {
    try {
      if (cid) {
        await deleteCredential(cid, c.namespace || "default", c.name);
      } else {
        await deleteCredentialDB(Number((c as any).id));
      }
      setDetail(null);
      setDelConfirm(false);
      reload();
    } catch (e: any) {
      setSaveErr(e?.message || "删除失败");
    }
  };

  const total = list.length;
  const globalCnt = list.filter((c) => c.scope === "全局").length;
  const errCnt = list.filter((c) => c.status === "err" || c.status === "warn").length;
  // 加载中（含切集群首次拉取真实数据）不展示 mock 预置数字，用占位符避免「先闪预制数、再跳真实数」的视觉抖动
  const kv = (v: number) => (loading ? "—" : v);
  // 关联流水线无真实数据源，固定占位，绝不展示 mock 推算的虚拟数字
  const linkedVal = "—";

  return (
    <div className="top-aura relative p-5 space-y-4">
      <SectionTitle
        title="代码凭证"
        desc="Git / 镜像仓库 / SSH / KubeConfig / TLS 凭据集中管理（真实集群 K8s Secret）"
        right={
          <button onClick={() => { resetForm(); setOpen(true); }} className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">
            <Plus size={15} /> 添加凭证
          </button>
        }
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rise-1"><KpiStat label="凭证总数" value={kv(total)} unit="个" icon={<KeyRound size={18} />} accent="brand" /></div>
        <div className="rise-2"><KpiStat label="全局凭证" value={kv(globalCnt)} unit="个" icon={<ShieldCheck size={18} />} accent="cyan" /></div>
        <div className="rise-3"><KpiStat label="关联流水线" value={linkedVal} unit="条" icon={<Plus size={18} />} accent="ok" /></div>
        <div className="rise-4"><KpiStat label="异常 / 过期" value={kv(errCnt)} unit="个" icon={<KeyRound size={18} />} accent="err" /></div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="ml-auto flex items-center gap-2 px-3 h-9 rounded-lg bg-sunken border border-line w-64 focus-within:border-brand-300 focus-within:bg-surface transition">
          <Search size={15} className="text-ink-400" />
          <input className="bg-transparent outline-none text-[12.5px] w-full placeholder:text-ink-300" placeholder="按凭证名称 / 类型搜索…" />
        </div>
      </div>

      {err && <ErrorBanner msg={err} />}
      {permDenied && <ErrorBanner msg="当前账号无该集群的访问权限，暂无数据展示" title="无集群访问权限" hint="当前账号未被授权访问该集群，已清空展示数据。" />}

      <Card beam={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-ink-400 text-[10.5px] font-semibold uppercase tracking-wider">
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">凭证名称</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">类型</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">作用域</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">Secret 引用</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">创建人</th>
                <th className="text-left font-semibold px-4 py-2.5 bg-subtle border-b border-line">最近使用</th>
                <th className="text-right font-semibold px-4 py-2.5 bg-subtle border-b border-line">状态</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[12px] text-ink-400">加载中…</td></tr>
              )}
              {!loading && list.map((c) => (
                <tr key={`${c.namespace ?? "db"}-${c.name}`} onClick={() => setDetail(c)} className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className={cn("w-7 h-7 rounded-lg border grid place-items-center text-[11px] font-bold", typeColor[c.type] ?? "bg-sunken text-ink-500")}>
                        {c.name[0]?.toUpperCase()}
                      </div>
                      <div className="font-mono text-[12.5px] font-semibold text-ink-900">{c.name}</div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5"><span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium", typeColor[c.type] ?? "bg-sunken text-ink-500")}>{c.type}</span></td>
                  <td className="px-4 py-2.5"><span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium", scopeColor[c.scope] ?? "bg-subtle text-ink-500")}>{c.scope}</span></td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-500">{secretDisplay(c)}</td>
                  <td className="px-4 py-2.5 text-ink-700">{c.createdBy}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-400">{c.lastUsed}</td>
                  <td className="px-4 py-2.5 text-right"><StatusBadge kind={c.status} label={c.status === "ok" ? "有效" : c.status === "warn" ? "即将过期" : c.status === "err" ? "失效" : "空闲"} /></td>
                </tr>
              ))}
              {!loading && list.length === 0 && !err && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[12px] text-ink-400">暂无凭证（选择集群后将列出真实 K8s Secret）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 添加凭证弹窗 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="添加代码凭证"
        desc="将写入真实集群 K8s Secret（或本地演示库）"
        icon={<KeyRound size={15} />}
        footer={
          <>
            <button onClick={() => setOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <PrimaryButton onClick={save}>{saving ? "保存中…" : "保存"}</PrimaryButton>
          </>
        }
      >
        {saveErr && <div className="mb-3 text-[12px] text-err">{saveErr}</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="凭证名称"><TextInput value={form.name} onChange={set("name")} placeholder="github-team" /></Field>
          <Field label="命名空间">
            <SelectInput value={form.namespace} onChange={set("namespace")}>
              {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
            </SelectInput>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="类型">
            <SelectInput value={form.type} onChange={set("type")}>
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </SelectInput>
          </Field>
          <Field label="作用域">
            <SelectInput value={form.scope} onChange={set("scope")}>
              <option>全局</option><option>企业空间</option><option>项目</option>
            </SelectInput>
          </Field>
        </div>

        {/* 按类型动态显示密钥字段 */}
        {(form.type === "GitHub" || form.type === "GitLab" || form.type === "Gitee") && (
          <Field label="Token / 访问令牌"><TextInput type="password" value={form.token} onChange={set("token")} placeholder="ghp_xxx / glpat_xxx" /></Field>
        )}
        {(form.type === "Harbor" || form.type === "Docker Hub") && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="镜像仓库地址" hint={form.type === "Harbor" ? "必填" : "Docker Hub 可留空"}>
              <TextInput value={form.registry} onChange={set("registry")} placeholder={form.type === "Docker Hub" ? "index.docker.io" : "harbor.example.com"} />
            </Field>
            <Field label="用户名"><TextInput value={form.username} onChange={set("username")} placeholder="admin" /></Field>
            <div className="col-span-2"><Field label="密码 / 令牌"><TextInput type="password" value={form.password} onChange={set("password")} placeholder="••••••••" /></Field></div>
          </div>
        )}
        {form.type === "SSH" && (
          <Field label="私钥 (PEM)" hint="ssh-privatekey"><TextArea rows={4} value={form.privateKey} onChange={set("privateKey")} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></Field>
        )}
        {form.type === "KubeConfig" && (
          <Field label="KubeConfig 内容" hint="kubeconfig"><TextArea rows={5} value={form.kubeconfig} onChange={set("kubeconfig")} placeholder="apiVersion: v1\nkind: Config\n..." /></Field>
        )}
        {form.type === "TLS" && (
          <div className="space-y-3">
            <Field label="证书 (tls.crt)" hint="证书与私钥均留空时可改用 Ingress 创建自动生成"><TextArea rows={4} value={form.cert} onChange={set("cert")} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            <Field label="私钥 (tls.key)"><TextArea rows={4} value={form.key} onChange={set("key")} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
          </div>
        )}
      </Modal>

      {/* 详情 + 删除弹窗 */}
      <Modal
        open={detail !== null}
        onClose={() => { setDetail(null); setDelConfirm(false); }}
        title="凭证详情"
        desc="密钥内容仅保存在集群 Secret 中，不在平台侧展示"
        icon={<KeyRound size={15} />}
        footer={
          delConfirm ? (
            <>
              <button onClick={() => setDelConfirm(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
              <button onClick={() => detail && remove(detail)} className="h-9 px-3.5 rounded-lg bg-err text-white text-[12.5px] font-medium hover:opacity-95 transition">确认删除</button>
            </>
          ) : (
            <>
              <button onClick={() => { setDetail(null); setDelConfirm(false); }} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">关闭</button>
              <button onClick={() => setDelConfirm(true)} className="h-9 px-3.5 rounded-lg border border-err text-err text-[12.5px] font-medium hover:bg-err/10 transition flex items-center gap-1.5"><Trash2 size={13} />删除</button>
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-2.5 text-[12.5px]">
            <Row label="名称" value={detail.name} mono />
            <Row label="类型" value={detail.type} />
            <Row label="作用域" value={detail.scope} />
            <Row label="命名空间" value={detail.namespace || "（本地演示库）"} mono />
            <Row label="Secret 引用" value={secretDisplay(detail)} mono />
            <Row label="创建人" value={detail.createdBy} />
            <Row label="最近使用" value={detail.lastUsed} mono />
            <div className="flex items-center gap-2 pt-1">
              <span className="text-ink-400 w-20">状态</span>
              <StatusBadge kind={detail.status} label={detail.status === "ok" ? "有效" : detail.status === "warn" ? "即将过期" : detail.status === "err" ? "失效" : "空闲"} />
            </div>
            <div className="rounded-lg border border-line bg-sunken/40 p-3 text-[11.5px] text-ink-500 leading-relaxed">
              删除操作将{detail.namespace ? `在集群命名空间 ${detail.namespace} 中移除 Secret ${detail.name}` : "从本地演示库移除该凭证"}，且不可恢复。
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-ink-400 w-20 shrink-0">{label}</span>
      <span className={cn("text-ink-900 truncate", mono && "font-mono text-[12px]")}>{value}</span>
    </div>
  );
}
