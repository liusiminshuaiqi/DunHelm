import { useEffect, useMemo, useState } from "react";
import {
  Plus, Server, Trash2, CheckCircle2, Check, ShieldCheck, Link2, Activity,
  AlertCircle,
} from "lucide-react";
import {
  Card, CardHead, PrimaryButton, GhostButton, SectionTitle, KpiStat,
  Modal, Field, TextInput, SelectInput, TextArea,
} from "@/components/ui/primitives";
import { useClusters } from "@/data/useLive";
import { apiSend } from "@/lib/api";
import { getCluster, setCluster, subscribeCluster, emitClusterRegistryChanged } from "@/lib/cluster";
import { cn } from "@/lib/utils";

/** 客户端预检结果类型 */
type H = { state: "empty" | "ok" | "warn" | "error"; msg: string };

function labelForHealth(h: string | undefined): string {
  switch (h) {
    case "ready": return "已连接";
    case "no-kubeconfig": return "待配置";
    case "parse-error": return "格式错误";
    case "connect-error": return "不可达";
    default: return "未连接";
  }
}

export function Clusters() {
  const { data: clusters, reload } = useClusters();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(getCluster());
  const [expandedErr, setExpandedErr] = useState<number | null>(null);

  useEffect(() => subscribeCluster(() => setCur(getCluster())), []);

  const connected = clusters.filter((c) => c.connected).length;
  const current = clusters.find((c) => String(c.id) === cur);

  const onSetCurrent = (id: number) => {
    setCluster(String(id));
    setCur(String(id));
  };

  const onDelete = async (id: number) => {
    if (!confirm("确定要删除该集群注册信息吗？此操作不可撤销。")) return;
    await apiSend("DELETE", `/clusters/${id}`);
    if (String(id) === cur) setCluster("");
    reload();
    emitClusterRegistryChanged();
  };

  return (
    <div className="p-5 max-w-[1180px] mx-auto">
      <SectionTitle
        title="集群管理"
        desc="注册并管理多集群的 KubeConfig，粘贴后即可在总览 / 节点 / 工作负载中查看真实数据"
        right={
          <PrimaryButton icon={<Plus size={15} />} onClick={() => setOpen(true)}>
            添加集群
          </PrimaryButton>
        }
      />

      <div className="grid grid-cols-3 gap-3 mb-5">
        <KpiStat label="集群总数" value={clusters.length} icon={<Server size={15} />} />
        <KpiStat label="已连接" value={connected} icon={<Link2 size={15} />} accent={connected > 0 ? "ok" : "brand"} />
        <KpiStat
          label="当前集群"
          value={current ? current.name : "未选择"}
          icon={<Activity size={15} />}
          accent="cyan"
        />
      </div>

      <Card>
        <CardHead title="已注册集群" sub={`${clusters.length} 个集群`} />
        <div className="px-4 pb-4">
          {clusters.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
              <div className="w-11 h-11 rounded-xl bg-brand-50 grid place-items-center">
                <Server size={20} className="text-brand-600" />
              </div>
              <div className="text-[13px] font-medium text-ink-700">尚未注册任何集群</div>
              <div className="text-[11.5px] text-ink-400 max-w-xs">
                点击右上角「添加集群」，粘贴集群的 KubeConfig 文本即可接入真实 Kubernetes 集群。
              </div>
              <button
                onClick={() => setOpen(true)}
                className="mt-1 text-[12.5px] font-medium text-brand-600 hover:underline"
              >
                + 立即添加
              </button>
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-400 text-[11px] uppercase tracking-wider border-b border-line">
                  <th className="text-left font-medium py-2 px-2">名称</th>
                  <th className="text-left font-medium py-2 px-2">提供商</th>
                  <th className="text-left font-medium py-2 px-2">区域</th>
                  <th className="text-left font-medium py-2 px-2">版本</th>
                  <th className="text-left font-medium py-2 px-2">连接状态</th>
                  <th className="text-right font-medium py-2 px-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map((c) => {
                  const isCur = String(c.id) === cur;
                  return (
                    <tr key={c.id} className="border-b border-line/70 last:border-0 hover:bg-sunken/50 transition">
                      <td className="py-2.5 px-2">
                        <div className="flex items-center gap-2">
                          <Server size={15} className="text-brand-600 shrink-0" />
                          <span className="font-medium text-ink-900 truncate">{c.name}</span>
                          {isCur && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-cyan-600 bg-cyan-100 px-1.5 py-0.5 rounded">
                              <Check size={10} /> 当前
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 text-ink-600">{c.provider || "—"}</td>
                      <td className="py-2.5 px-2 font-mono text-[11.5px] text-ink-500">{c.region || "—"}</td>
                      <td className="py-2.5 px-2 font-mono text-[11.5px] text-ink-500">{c.clusterVersion || c.version || "—"}</td>
                      <td className="py-2.5 px-2 align-top">
                        {c.connected ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex w-fit items-center gap-1.5 text-[11px] font-medium text-ok bg-ok-bg px-2 py-0.5 rounded-full">
                              <CheckCircle2 size={12} /> 已连接
                            </span>
                            {c.clusterVersion && (
                              <span className="text-[10.5px] text-ink-400 font-mono">{c.clusterVersion}</span>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span
                              onClick={() => c.healthMessage && setExpandedErr(expandedErr === c.id ? null : c.id)}
                              className={cn(
                                "inline-flex w-fit items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full cursor-pointer transition",
                                c.health === "parse-error"
                                  ? "text-err bg-err-bg hover:bg-err/15"
                                  : c.healthMessage
                                    ? "text-warn bg-warn-bg hover:bg-warn/15"
                                    : "text-ink-400 bg-idle-bg",
                              )}
                              title={c.healthMessage || "尚未配置 KubeConfig"}
                            >
                              <AlertCircle size={12} /> {labelForHealth(c.health)}
                            </span>
                            {expandedErr === c.id && c.healthMessage && (
                              <div className="mt-1.5 max-w-[320px] rounded-md border border-err/30 bg-err-bg/40 px-2.5 py-1.5 text-[11px] text-err font-mono whitespace-pre-wrap break-all leading-snug">
                                {c.healthMessage}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="flex items-center justify-end gap-1.5">
                          {!isCur && (
                            <GhostButton onClick={() => onSetCurrent(c.id)} className="!h-8 !px-2.5 text-[11.5px]">
                              设为当前
                            </GhostButton>
                          )}
                          <button
                            onClick={() => onDelete(c.id)}
                            className="w-8 h-8 grid place-items-center rounded-md text-ink-400 hover:text-err hover:bg-err-bg transition"
                            title="删除集群"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <AddClusterModal
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(id) => { setCluster(String(id)); setCur(String(id)); reload(); emitClusterRegistryChanged(); setOpen(false); }}
      />
    </div>
  );
}

function AddClusterModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("自建集群");
  const [region, setRegion] = useState("");
  const [context, setContext] = useState("");
  const [kubeConfig, setKubeConfig] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(""); setProvider("自建集群"); setRegion(""); setContext(""); setKubeConfig(""); setErr(null); setBusy(false); }
  }, [open]);

  /**
   * 客户端预检：找出最常见的"粘贴 KubeConfig 时混进了终端内容"的坑。
   * 检测到 shell prompt / 控制字符 / 末尾的 statistics 等典型污染。
   */
  const previewHint = useMemo<H>(() => {
    const t = kubeConfig.trim();
    if (!t) return { state: "empty", msg: "" };
    const looksLikeShell = /^[#$]\s|\[root@/m.test(t) || /\bping\b.*\bstatistics\b/i.test(t);
    if (looksLikeShell) {
      return {
        state: "error",
        msg: "看起来粘贴的内容混入了终端命令或输出。请只粘贴 KubeConfig 本身的 YAML（以 apiVersion: v1 开头、以 ... 或 users 段结尾），不要包含命令行或终端回显。",
      };
    }
    if (!/^apiVersion:\s*v1/m.test(t)) {
      return { state: "warn", msg: "未检测到 \"apiVersion: v1\" 起始行，确认这是 KubeConfig？参考 Kubernetes 文档里的 ~/.kube/config 格式。" };
    }
    if (!/^\s*(clusters:|users:|contexts:)/m.test(t)) {
      return { state: "warn", msg: "缺少 clusters/users/contexts 等核心段，KubeConfig 不完整。" };
    }
    // 控制字符：含 0x00-0x08 / 0x0B-0x0C / 0x0E-0x1F 通常意味着粘贴时引入了不可见字符
    if (/[\x00-\x08\x0B-\x0C\x0E-\x1F]/.test(t)) {
      return { state: "error", msg: "检测到控制字符（不可见），可能是复制时引入的，尝试在编辑器中重新另存为纯文本再粘贴。" };
    }
    return { state: "ok", msg: "格式初步检查通过，提交后将由后端进行真实解析与连通性探测。" };
  }, [kubeConfig]);

  const submit = async () => {
    if (!name.trim()) { setErr("请填写集群名称"); return; }
    if (!kubeConfig.trim()) { setErr("请粘贴 KubeConfig 文本"); return; }
    if (previewHint.state === "error") { setErr(previewHint.msg); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await apiSend<{ id: number }>("POST", "/clusters", {
        name: name.trim(),
        provider,
        region: region.trim(),
        context: context.trim(),
        kubeConfig,
      });
      onCreated(res.id);
    } catch (e) {
      setErr((e as Error).message || "注册失败");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="添加集群"
      desc="粘贴集群的 KubeConfig，保存后将自动探测连通性"
      icon={<ShieldCheck size={16} />}
      footer={
        <>
          <GhostButton onClick={onClose}>取消</GhostButton>
          <PrimaryButton icon={<Plus size={15} />} onClick={submit}>
            {busy ? "注册中…" : "注册集群"}
          </PrimaryButton>
        </>
      }
    >
      <Field label="集群名称" hint="必填">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 prod-cluster-01" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="提供商">
          <SelectInput value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option>自建集群</option>
            <option>阿里云 ACK</option>
            <option>腾讯云 TKE</option>
            <option>AWS EKS</option>
            <option>Google GKE</option>
            <option>其他</option>
          </SelectInput>
        </Field>
        <Field label="区域">
          <TextInput value={region} onChange={(e) => setRegion(e.target.value)} placeholder="例如 ap-guangzhou" />
        </Field>
      </div>

      <Field label="默认 Context" hint="可选">
        <TextInput
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="留空则使用 KubeConfig 中的 current-context"
        />
      </Field>

      <Field label="KubeConfig" hint="必填">
        <TextArea
          rows={10}
          value={kubeConfig}
          onChange={(e) => setKubeConfig(e.target.value)}
          placeholder={"apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://<apiserver>:6443\n  name: kubernetes\n..."}
        />
      </Field>

      {previewHint.state !== "empty" && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2",
            previewHint.state === "ok" && "border-ok/30 bg-ok-bg/40",
            previewHint.state === "warn" && "border-warn/30 bg-warn-bg/40",
            previewHint.state === "error" && "border-err/30 bg-err-bg/40",
          )}
        >
          <AlertCircle
            size={14}
            className={cn(
              "mt-[2px] shrink-0",
              previewHint.state === "ok" && "text-ok",
              previewHint.state === "warn" && "text-warn",
              previewHint.state === "error" && "text-err",
            )}
          />
          <span
            className={cn(
              "text-[11.5px] leading-relaxed",
              previewHint.state === "ok" && "text-ok",
              previewHint.state === "warn" && "text-warn",
              previewHint.state === "error" && "text-err",
            )}
          >
            {previewHint.msg}
          </span>
        </div>
      )}

      {err && (
        <div className="flex items-start gap-2 rounded-lg border border-err/30 bg-err-bg px-3 py-2.5">
          <span className="text-[12px] text-err leading-relaxed">{err}</span>
        </div>
      )}
    </Modal>
  );
}
