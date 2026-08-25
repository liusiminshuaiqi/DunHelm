import { useMemo, useState } from "react";
import { Card, Modal, Field, TextInput, SelectInput } from "@/components/ui/primitives";
import { marketTemplates, type AppTemplate } from "@/data/mock";
import { Search, Star, Download, ShieldCheck, Rocket, Info } from "lucide-react";

const categories = ["全部", "数据库", "中间件", "AI", "Web", "监控", "DevOps"] as const;

export function Market() {
  const [cat, setCat] = useState<(typeof categories)[number]>("全部");
  const [q, setQ] = useState("");
  const [deploy, setDeploy] = useState<AppTemplate | null>(null);
  const [detail, setDetail] = useState<AppTemplate | null>(null);
  const [form, setForm] = useState({ namespace: "ns-payment", replicas: "1" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const list = useMemo(() => {
    return marketTemplates.filter((t) => {
      const okCat = cat === "全部" || t.category === cat;
      const okQ = !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.desc.includes(q);
      return okCat && okQ;
    });
  }, [cat, q]);

  return (
    <div className="top-aura relative p-5 space-y-4">
      {/* 头部：标题 + 搜索 + 分类 */}
      <div className="flex flex-wrap items-center gap-3 rise-1">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索应用模板…"
            className="w-full pl-9 pr-3 py-2 text-[13px] rounded-md bg-surface border border-line focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100 transition"
          />
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-sunken border border-line">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={
                "px-3 py-1.5 rounded-md text-[12px] font-medium transition " +
                (cat === c ? "bg-surface text-brand-700 shadow-sh-1" : "text-ink-500 hover:text-ink-900")
              }
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 模板卡片网格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((t, i) => (
          <Card key={t.name} hover beam={false} className={`rise-${(i % 5) + 1} group`}>
            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[13px] font-bold shadow-[0_4px_12px_-3px_rgba(19,96,196,.5)] flex-none">
                  {t.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-[14px] font-semibold text-ink-900 truncate">{t.name}</h3>
                    {t.official && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-medium text-brand-600 bg-brand-50 border border-brand-100 rounded px-1">
                        <ShieldCheck size={9} /> 官方
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-400 font-mono mt-0.5">v{t.version}</div>
                </div>
                <span className="text-[10px] font-medium text-ink-400 bg-sunken rounded-full px-2 py-0.5 flex-none">{t.category}</span>
              </div>

              <p className="text-[12px] text-ink-500 mt-3 leading-relaxed line-clamp-2 h-[34px]">{t.desc}</p>

              <div className="flex items-center gap-4 mt-3 text-[11px] text-ink-400">
                <span className="inline-flex items-center gap-1"><Star size={12} className="text-amber-500 fill-amber-500" />{t.rating}</span>
                <span className="inline-flex items-center gap-1"><Download size={12} />{t.deploys.toLocaleString()} 次部署</span>
              </div>

              <div className="flex items-center gap-2 mt-3.5 pt-3 border-t border-line">
                <button onClick={() => setDeploy(t)} className="flex-1 py-1.5 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-[12px] font-medium transition">一键部署</button>
                <button onClick={() => setDetail(t)} className="px-3 py-1.5 rounded-md border border-line text-ink-500 hover:border-brand-300 hover:text-brand-600 text-[12px] font-medium transition">详情</button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {list.length === 0 && (
        <Card><div className="p-10 text-center text-ink-400 text-[13px]">没有匹配「{q}」的模板</div></Card>
      )}

      {/* 部署弹窗 */}
      <Modal
        open={!!deploy}
        onClose={() => setDeploy(null)}
        title="部署应用"
        desc={deploy ? `${deploy.name} v${deploy.version} · ${deploy.category}` : ""}
        icon={<Rocket size={15} />}
        footer={
          <>
            <button onClick={() => setDeploy(null)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button onClick={() => setDeploy(null)} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">部署</button>
          </>
        }
      >
        {deploy && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="实例名称"><TextInput value={deploy.name} readOnly /></Field>
            <Field label="命名空间"><SelectInput value={form.namespace} onChange={set("namespace")}><option>ns-payment</option><option>ns-order</option><option>ns-gateway</option><option>ns-ai-train</option><option>ns-monitor</option></SelectInput></Field>
            <Field label="副本数"><TextInput type="number" min={1} value={form.replicas} onChange={set("replicas")} /></Field>
            <Field label="版本" hint="默认最新"><TextInput value={`v${deploy.version}`} readOnly /></Field>
          </div>
        )}
      </Modal>

      {/* 详情弹窗 */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title="应用模板详情"
        desc={detail ? `${detail.name} v${detail.version}` : ""}
        icon={<Info size={15} />}
        footer={
          <button onClick={() => setDetail(null)} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">知道了</button>
        }
      >
        {detail && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[14px] font-bold">{detail.icon}</div>
              <div>
                <div className="text-[14px] font-semibold text-ink-900 flex items-center gap-1.5">
                  {detail.name}
                  {detail.official && <span className="text-[9px] font-medium text-brand-600 bg-brand-50 border border-brand-100 rounded px-1">官方</span>}
                </div>
                <div className="font-mono text-[11px] text-ink-400 mt-0.5">{detail.category} · v{detail.version}</div>
              </div>
            </div>
            <p className="text-[12.5px] text-ink-500 leading-relaxed">{detail.desc}</p>
            <div className="flex items-center gap-6 text-[12px] text-ink-500">
              <span className="inline-flex items-center gap-1"><Star size={13} className="text-amber-500 fill-amber-500" />{detail.rating} 评分</span>
              <span className="inline-flex items-center gap-1"><Download size={13} />{detail.deploys.toLocaleString()} 次部署</span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
