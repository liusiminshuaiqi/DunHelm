import { useEffect, useState } from "react";
import { Search, Bell, Settings, Terminal, Activity, ChevronDown, Copy, Check, Play, Server, CheckCircle2, Circle, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMyClusters } from "@/data/useLive";
import { getCluster, setCluster, subscribeCluster } from "@/lib/cluster";
import { logout, getCurrentUser } from "@/lib/api";
import { Settings2 } from "lucide-react";

const kubectlCmds = [
  "kubectl get pods -n ns-payment",
  "kubectl describe deploy payment-api",
  "kubectl logs -f deploy/order-svc",
  "kubectl apply -f deploy.yaml",
  "kubectl rollout restart deploy/gateway-envoy",
];

export function Topbar({ title, subtitle, onManageClusters }: { title: string; subtitle?: string; onManageClusters?: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [cOpen, setCOpen] = useState(false);
  const { data: clusters } = useMyClusters();
  const [cur, setCur] = useState(getCluster());
  useEffect(() => subscribeCluster(() => setCur(getCluster())), []);
  // cur 必须落在用户有权限的 clusters 列表里才显示；否则显示「选择集群」，不把 clusters[0] 误当成当前集群
  const active = clusters.find((c) => String(c.id) === cur) || (cur ? undefined : clusters[0]);
  const me = getCurrentUser();

  const copy = (cmd: string) => {
    navigator.clipboard?.writeText(cmd).catch(() => {});
    setCopied(cmd);
    setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1200);
  };

  return (
    <header className="h-14 flex-none flex items-center gap-4 px-5 border-b border-line bg-surface/80 backdrop-blur-md sticky top-0 z-20">
      <div className="min-w-0">
        <h1 className="text-[15px] font-semibold text-ink-900 tracking-tight leading-none">{title}</h1>
        {subtitle && <p className="text-[11px] text-ink-400 mt-1 truncate">{subtitle}</p>}
      </div>

      <div className="ml-2 hidden md:flex items-center gap-2 px-3 h-9 rounded-md bg-sunken border border-line w-72 focus-within:border-brand-300 focus-within:shadow-glow transition">
        <Search size={15} className="text-ink-400" />
        <input
          className="bg-transparent outline-none text-[12.5px] text-ink-900 placeholder:text-ink-300 w-full"
          placeholder="搜索资源、镜像、流水线…"
        />
        <kbd className="font-mono text-[10px] text-ink-400 border border-line rounded px-1 py-0.5 bg-surface">⌘K</kbd>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {/* 集群选择器（多集群） */}
        <div className="relative">
          <button
            onClick={() => setCOpen((o) => !o)}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-line bg-surface text-[12.5px] text-ink-700 hover:border-brand-300 transition min-w-[150px]"
          >
            <Server size={15} className="text-brand-600 shrink-0" />
            <span className="flex-1 text-left truncate">{active ? active.name : "选择集群"}</span>
            {active &&
              (active.connected ? (
                <CheckCircle2 size={13} className="text-ok shrink-0" />
              ) : (
                <Circle size={13} className="text-ink-300 shrink-0" />
              ))}
            <ChevronDown size={13} className={cn("transition shrink-0", cOpen && "rotate-180")} />
          </button>
          {cOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setCOpen(false)} />
              <div className="absolute right-0 top-11 z-20 w-64 rounded-xl border border-line bg-surface shadow-sh-3 overflow-hidden card-beam">
                <div className="px-3.5 py-2.5 border-b border-line bg-subtle">
                  <span className="text-[12px] font-semibold text-ink-900">集群</span>
                </div>
                <div className="p-1.5 space-y-0.5 max-h-72 overflow-auto">
                  {clusters.length === 0 && (
                    <div className="px-2.5 py-3 text-[11.5px] text-ink-400">暂无已注册集群</div>
                  )}
                  {clusters.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        // 选中集群同时把快照写入 localStorage，以便 Sidebar / 标题等组件
                        // 同步读取（避免显示陈旧 mock.cluster 数据）。
                        setCluster(String(c.id), {
                          name: c.name,
                          provider: c.provider || "",
                          region: c.region || "",
                          version: c.version,
                          clusterVersion: c.clusterVersion,
                        });
                        setCur(String(c.id));
                        setCOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-brand-50 transition",
                        String(c.id) === cur && "bg-brand-50",
                      )}
                    >
                      <Server size={14} className="text-brand-600 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] text-ink-900 truncate">{c.name}</div>
                        <div className="text-[10.5px] text-ink-400 truncate">
                          {c.provider}
                          {c.region ? ` · ${c.region}` : ""}
                        </div>
                      </div>
                      {c.connected ? (
                        <CheckCircle2 size={13} className="text-ok shrink-0" />
                      ) : (
                        <Circle size={13} className="text-ink-300 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => { setCOpen(false); onManageClusters?.(); }}
                  className="flex items-center gap-2 w-full px-3.5 py-2.5 text-left text-[12px] font-medium text-brand-700 hover:bg-brand-50 border-t border-line transition"
                >
                  <Settings2 size={14} /> 管理集群
                </button>
              </div>
            </>
          )}
        </div>

        {/* Kubectl 快捷面板 */}
        <div className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition"
          >
            <Terminal size={15} /> Kubectl <ChevronDown size={13} className={cn("transition", open && "rotate-180")} />
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute right-0 top-11 z-20 w-80 rounded-xl border border-line bg-surface shadow-sh-3 overflow-hidden card-beam">
                <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line bg-subtle">
                  <Terminal size={13} className="text-brand-600" />
                  <span className="text-[12px] font-semibold text-ink-900">Kubectl 控制台</span>
                  <span className="ml-auto font-mono text-[10px] text-ok bg-ok-bg px-1.5 py-0.5 rounded">已连接</span>
                </div>
                <div className="p-1.5 space-y-0.5">
                  {kubectlCmds.map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => copy(cmd)}
                      className="group w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-brand-50 transition"
                    >
                      <Play size={11} className="text-brand-500 shrink-0" />
                      <code className="flex-1 font-mono text-[11.5px] text-ink-800 truncate">{cmd}</code>
                      {copied === cmd ? (
                        <Check size={12} className="text-ok shrink-0" />
                      ) : (
                        <Copy size={12} className="text-ink-300 group-hover:text-brand-600 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="px-3.5 py-2 border-t border-line bg-subtle">
                  <span className="text-[10.5px] text-ink-400 font-mono">prod-cluster-01 · context: prod-admin</span>
                </div>
              </div>
            </>
          )}
        </div>
        <button className="relative w-9 h-9 grid place-items-center rounded-md text-ink-500 hover:bg-sunken transition">
          <Activity size={17} />
        </button>
        <button className="relative w-9 h-9 grid place-items-center rounded-md text-ink-500 hover:bg-sunken transition">
          <Bell size={17} />
          <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-err" />
        </button>
        <button className="w-9 h-9 grid place-items-center rounded-md text-ink-500 hover:bg-sunken transition">
          <Settings size={17} />
        </button>
        {me && (
          <div className="flex items-center gap-2 pl-1">
            <div className="flex items-center gap-2 h-9 px-2.5 rounded-md bg-sunken border border-line">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[10px] font-bold">
                {me.username.slice(0, 1).toUpperCase()}
              </div>
              <span className="text-[12px] text-ink-700 max-w-[90px] truncate">{me.username}</span>
            </div>
            <button
              onClick={() => logout()}
              title="退出登录"
              className="w-9 h-9 grid place-items-center rounded-md text-ink-500 hover:bg-sunken hover:text-err transition"
            >
              <LogOut size={17} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
