import { useState } from "react";
import { Card, KpiStat, StatusBadge, MiniGauge, SectionTitle, Modal, Field, TextInput } from "@/components/ui/primitives";
import { useWorkspaces } from "@/data/useLive";
import { apiSend } from "@/lib/api";
import { Building2, FolderKanban, Users, Plus } from "lucide-react";

export function Workspaces() {
  const { data: workspaces, reload } = useWorkspaces();
  const totalProjects = workspaces.reduce((s, w) => s + w.projects, 0);
  const totalMembers = workspaces.reduce((s, w) => s + w.members, 0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", admin: "", quotaCpu: "50", quotaMem: "50" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = async () => {
    if (!form.name) return;
    try {
      await apiSend("POST", "/workspaces", {
        name: form.name,
        admin: form.admin,
        quotaCpu: Number(form.quotaCpu),
        quotaMem: Number(form.quotaMem),
      });
      setForm({ name: "", admin: "", quotaCpu: "50", quotaMem: "50" });
      setOpen(false);
      reload();
    } catch {
      /* 忽略：保持弹窗可重试 */
    }
  };
  return (
    <div className="top-aura relative p-5 space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <div className="rise-1"><KpiStat label="企业空间" value={workspaces.length} unit="个" icon={<Building2 size={18} />} accent="brand" /></div>
        <div className="rise-2"><KpiStat label="项目总数" value={totalProjects} unit="个" delta="+3 本月" deltaUp icon={<FolderKanban size={18} />} accent="cyan" /></div>
        <div className="rise-3"><KpiStat label="成员总数" value={totalMembers} unit="人" icon={<Users size={18} />} accent="ok" /></div>
      </div>

      {/* 空间卡片网格 */}
      <SectionTitle
        title="企业空间"
        desc="多租户隔离与资源配额"
        right={
          <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">
            <Plus size={15} /> 创建企业空间
          </button>
        }
      />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {workspaces.map((w, i) => (
          <Card key={w.name} hover className={`rise-${(i % 5) + 1}`}>
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[12px] font-bold flex-none">
                    {w.name.replace("ws-", "").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono text-[13px] font-semibold text-ink-900 truncate">{w.name}</div>
                    <div className="text-[11px] text-ink-400">管理员 · {w.admin}</div>
                  </div>
                </div>
                <StatusBadge kind={w.status} />
              </div>

              <div className="flex items-center gap-4 mt-3 text-[11px] text-ink-400">
                <span className="inline-flex items-center gap-1"><FolderKanban size={12} />{w.projects} 项目</span>
                <span className="inline-flex items-center gap-1"><Users size={12} />{w.members} 成员</span>
              </div>

              <div className="mt-3 pt-3 border-t border-line space-y-2">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="text-ink-500">CPU 配额</span>
                  <MiniGauge value={w.quotaCpu} tone={w.quotaCpu >= 90 ? "err" : w.quotaCpu >= 80 ? "warn" : "ok"} />
                </div>
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="text-ink-500">内存配额</span>
                  <MiniGauge value={w.quotaMem} tone={w.quotaMem >= 90 ? "err" : w.quotaMem >= 80 ? "warn" : "ok"} />
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* 创建企业空间弹窗 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="创建企业空间"
        desc="多租户隔离 · 资源配额管理"
        icon={<Building2 size={15} />}
        footer={
          <>
            <button onClick={() => setOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={create} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="空间名称"><TextInput value={form.name} onChange={set("name")} placeholder="ws-demo" /></Field>
          <Field label="管理员"><TextInput value={form.admin} onChange={set("admin")} placeholder="张三" /></Field>
          <Field label="CPU 配额上限" hint="%"><TextInput type="number" value={form.quotaCpu} onChange={set("quotaCpu")} /></Field>
          <Field label="内存配额上限" hint="%"><TextInput type="number" value={form.quotaMem} onChange={set("quotaMem")} /></Field>
        </div>
      </Modal>
    </div>
  );
}
