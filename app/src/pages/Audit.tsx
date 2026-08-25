import { useEffect, useMemo, useState } from "react";
import { Card, CardHead, KpiStat, Modal, Field, TextInput, SelectInput } from "@/components/ui/primitives";
import { listAudit, getAuditSummary, exportAuditUrl, type AuditRow, type AuditSummary } from "@/lib/api";
import { ScrollText, CalendarClock, ShieldX, AlertTriangle, X, Filter, Download } from "lucide-react";
import { cn } from "@/lib/utils";

// action 显示中文（与后端标准 action 常量对齐）
const ACTION_LABEL: Record<string, string> = {
  "login": "登录",
  "login.failed": "登录失败",
  "user.create": "创建用户",
  "user.update": "更新用户",
  "user.delete": "删除用户",
  "user.set_active": "启/禁用户",
  "user.set_status": "状态变更",
  "role.create": "创建角色",
  "role.update": "更新角色",
  "role.delete": "删除角色",
  "role.menu.set": "设置角色菜单",
  "permission.assign": "分配集群权限",
  "permission.revoke": "撤销集群权限",
  "cluster.register": "注册集群",
  "cluster.delete": "删除集群",
  "pipeline.create": "创建流水线",
  "pipeline.update": "更新流水线",
  "pipeline.delete": "删除流水线",
  "pipeline.run": "运行流水线",
  "pipeline.run.abort": "中止构建",
  "credential.create": "创建凭证",
  "credential.delete": "删除凭证",
  "registry.create": "新增镜像仓库",
  "registry.delete": "删除镜像仓库",
  "forbidden": "越权拒绝",
};

function formatTime(t: string): string {
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const PAGE_SIZE = 50;

export function Audit() {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [items, setItems] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ actor: "", action: "", resourceType: "", result: "", from: "", to: "" });
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<AuditRow | null>(null);

  // 拉 summary
  useEffect(() => {
    let alive = true;
    getAuditSummary()
      .then((d) => alive && setSummary(d))
      .catch(() => alive && setSummary(null));
    return () => { alive = false; };
  }, []);

  // 拉列表
  useEffect(() => {
    let alive = true;
    setLoading(true);
    listAudit({
      actor: filter.actor || undefined,
      action: filter.action || undefined,
      resourceType: filter.resourceType || undefined,
      result: filter.result || undefined,
      from: filter.from ? filter.from + "T00:00:00Z" : undefined,
      to: filter.to ? filter.to + "T23:59:59Z" : undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((d) => {
        if (!alive) return;
        setItems(d.items || []);
        setTotal(d.total || 0);
      })
      .catch(() => alive && (setItems([]), setTotal(0)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filter.actor, filter.action, filter.resourceType, filter.result, offset]);

  const filterSummary = useMemo(() => {
    const has = filter.actor || filter.action || filter.resourceType || filter.result || filter.from || filter.to;
    return has ? `（已过滤 ${total} 条）` : "";
  }, [filter, total]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const curPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="top-aura relative p-5 space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rise-1"><KpiStat label="审计事件总数" value={summary?.total ?? 0} unit="条" icon={<ScrollText size={18} />} accent="brand" /></div>
        <div className="rise-2"><KpiStat label="今日新增" value={summary?.today ?? 0} unit="条" icon={<CalendarClock size={18} />} accent="cyan" /></div>
        <div className="rise-3"><KpiStat label="被拒绝操作" value={summary?.denied ?? 0} unit="次" icon={<ShieldX size={18} />} accent="err" /></div>
        <div className="rise-4"><KpiStat label="敏感操作" value={summary?.sensitive ?? 0} unit="次" icon={<AlertTriangle size={18} />} accent="warn" /></div>
      </div>

      {/* Top actors + 最近敏感 */}
      {summary && (summary.topActors.length > 0 || summary.recentSensitive.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {summary.topActors.length > 0 && (
            <Card className="rise-2">
              <CardHead title="高频操作人 Top 5" sub="近 30 天累计" />
              <div className="p-4 space-y-2">
                {summary.topActors.map((a, i) => {
                  const max = Math.max(...summary.topActors.map((x) => x.count));
                  const pct = max > 0 ? (a.count / max) * 100 : 0;
                  return (
                    <div key={a.actorName} className="flex items-center gap-2 text-[12px]">
                      <span className="w-5 text-ink-400 font-mono">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-ink-700 truncate">{a.actorName}</span>
                          <span className="font-mono text-ink-500 tabular-nums">{a.count}</span>
                        </div>
                        <div className="h-1.5 bg-sunken rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-brand-500 to-cyan-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
          {summary.recentSensitive.length > 0 && (
            <Card className="xl:col-span-2 rise-3">
              <CardHead title="最近敏感操作" sub="用户/角色/权限/集群/凭证/流水线变更" />
              <div className="p-4 space-y-1.5 max-h-[280px] overflow-y-auto">
                {summary.recentSensitive.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-[11.5px] border-l-2 border-warn pl-2.5 py-1">
                    <span className="font-mono text-ink-400 shrink-0">{formatTime(a.time).slice(11)}</span>
                    <span className="text-ink-900 font-medium truncate">{ACTION_LABEL[a.action] ?? a.action}</span>
                    <span className="text-ink-400 shrink-0">·</span>
                    <span className="text-ink-700 truncate">{a.actorName}</span>
                    <span className="text-ink-400 shrink-0">·</span>
                    <span className="font-mono text-[10.5px] text-ink-500 truncate">{a.resourceName}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* 筛选条 */}
      <Card className="rise-2">
        <CardHead title="审计日志" sub={`${total} 条记录 ${filterSummary} · 点击行查看详情`} right={
          <div className="flex items-center gap-1.5">
            <a
              href={exportAuditUrl({
                actor: filter.actor || undefined,
                action: filter.action || undefined,
                resourceType: filter.resourceType || undefined,
                result: filter.result || undefined,
                from: filter.from ? filter.from + "T00:00:00Z" : undefined,
                to: filter.to ? filter.to + "T23:59:59Z" : undefined,
                format: "csv",
              })}
              className="h-8 px-2.5 rounded-md border border-line bg-surface text-[11.5px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1"
              download
            >
              <Download size={11} /> 导出 CSV
            </a>
            <button
              onClick={() => { setOffset(0); setFilter({ actor: "", action: "", resourceType: "", result: "", from: "", to: "" }); }}
              className="h-8 px-2.5 rounded-md border border-line bg-surface text-[11.5px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1"
            >
              <X size={11} /> 清空
            </button>
          </div>
        } />
        <div className="px-4 py-3 border-b border-line">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-300 mb-2">
            <Filter size={10} /> 筛选条件
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <Field label="操作人（模糊）">
              <TextInput value={filter.actor} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, actor: e.target.value })); }} placeholder="如 admin" />
            </Field>
            <Field label="动作（精确）">
              <SelectInput value={filter.action} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, action: e.target.value })); }}>
                <option value="">全部动作</option>
                {Object.entries(ACTION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}（{k}）</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="资源类型">
              <SelectInput value={filter.resourceType} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, resourceType: e.target.value })); }}>
                <option value="">全部类型</option>
                <option value="user">user 用户</option>
                <option value="role">role 角色</option>
                <option value="permission">permission 权限</option>
                <option value="cluster">cluster 集群</option>
                <option value="pipeline">pipeline 流水线</option>
                <option value="credential">credential 凭证</option>
                <option value="registry">registry 镜像仓库</option>
                <option value="platform">platform 平台</option>
              </SelectInput>
            </Field>
            <Field label="结果">
              <SelectInput value={filter.result} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, result: e.target.value })); }}>
                <option value="">全部结果</option>
                <option value="ok">成功</option>
                <option value="denied">拒绝</option>
                <option value="error">错误</option>
              </SelectInput>
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mt-2.5">
            <Field label="开始时间（含）">
              <TextInput type="date" value={filter.from} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, from: e.target.value })); }} />
            </Field>
            <Field label="结束时间（含）">
              <TextInput type="date" value={filter.to} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, to: e.target.value })); }} />
            </Field>
            <Field label="快速范围">
              <SelectInput value="" onChange={(e) => {
                setOffset(0);
                const days = Number(e.target.value);
                if (days > 0) {
                  const end = new Date();
                  const start = new Date(end.getTime() - (days - 1) * 86400000);
                  const fmt = (d: Date) => d.toISOString().slice(0, 10);
                  setFilter((f) => ({ ...f, from: fmt(start), to: fmt(end) }));
                } else {
                  setFilter((f) => ({ ...f, from: "", to: "" }));
                }
              }}>
                <option value="">全部时间</option>
                <option value="7">近 7 天</option>
                <option value="30">近 30 天</option>
                <option value="90">近 90 天</option>
              </SelectInput>
            </Field>
          </div>
        </div>
        <div className="px-2 pb-2 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-ink-400 text-[11px] font-medium">
                <th className="text-left font-medium px-3 py-2 w-[140px]">时间</th>
                <th className="text-left font-medium px-3 py-2">操作</th>
                <th className="text-left font-medium px-3 py-2 w-[120px]">操作人</th>
                <th className="text-left font-medium px-3 py-2">资源</th>
                <th className="text-left font-medium px-3 py-2 w-[80px]">集群</th>
                <th className="text-right font-medium px-3 py-2 w-[80px]">结果</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-ink-400 text-[12px]">加载中…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-ink-400 text-[12px]">暂无审计记录</td></tr>
              )}
              {!loading && items.map((a) => (
                <tr key={a.id} onClick={() => setDetail(a)} className="border-t border-line hover:bg-subtle cursor-pointer transition">
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-400">{formatTime(a.time)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-ink-900 font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
                      <span className="text-[10.5px] text-ink-300 font-mono leading-none">{a.action}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[10px] font-bold shrink-0">
                      {(a.actorName || "?").slice(0, 1)}
                    </div>
                    <span className="text-ink-700 truncate">{a.actorName || "—"}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-700">
                    {a.resourceName || "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-500">{a.clusterId > 0 ? `#${a.clusterId}` : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={cn(
                      "inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5",
                      a.result === "ok" ? "text-ok bg-ok-bg"
                        : a.result === "denied" ? "text-err bg-err-bg"
                          : "text-warn bg-warn-bg",
                    )}>
                      <span className={cn("w-1.5 h-1.5 rounded-full", a.result === "ok" ? "bg-ok" : a.result === "denied" ? "bg-err" : "bg-warn")} />
                      {a.result === "ok" ? "成功" : a.result === "denied" ? "拒绝" : "错误"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 分页 */}
        <div className="px-4 py-2.5 border-t border-line flex items-center justify-between text-[11.5px] text-ink-500">
          <span>第 {curPage} / {totalPages} 页 · 共 {total} 条</span>
          <div className="flex items-center gap-1">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="h-7 px-2.5 rounded-md border border-line bg-surface text-ink-700 hover:border-brand-300 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              上一页
            </button>
            <button
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="h-7 px-2.5 rounded-md border border-line bg-surface text-ink-700 hover:border-brand-300 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              下一页
            </button>
          </div>
        </div>
      </Card>

      {/* 详情抽屉 */}
      <AuditDetailDrawer detail={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function AuditDetailDrawer({ detail, onClose }: { detail: AuditRow | null; onClose: () => void }) {
  if (!detail) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`审计详情 #${detail.id}`}
      desc={`${formatTime(detail.time)} · ${ACTION_LABEL[detail.action] ?? detail.action}`}
      icon={<ScrollText size={15} />}
      maxW="max-w-lg"
      footer={
        <button onClick={onClose} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">
          关闭
        </button>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="操作人">
            <div className="flex items-center gap-2 h-9 px-3 rounded-md border border-line bg-subtle">
              <div className="w-5 h-5 rounded-full bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[9px] font-bold shrink-0">{(detail.actorName || "?").slice(0, 1)}</div>
              <span className="text-ink-900 text-[12px] truncate">{detail.actorName || "anonymous"}</span>
              {detail.actorId > 0 && <span className="ml-auto font-mono text-[10px] text-ink-400">id={detail.actorId}</span>}
            </div>
          </Field>
          <Field label="结果">
            <div className={cn(
              "h-9 px-3 rounded-md border flex items-center gap-2 text-[12px]",
              detail.result === "ok" ? "bg-ok-bg border-ok/30 text-ok"
                : detail.result === "denied" ? "bg-err-bg border-err/30 text-err"
                  : "bg-warn-bg border-warn/30 text-warn",
            )}>
              <span className={cn("w-1.5 h-1.5 rounded-full", detail.result === "ok" ? "bg-ok" : detail.result === "denied" ? "bg-err" : "bg-warn")} />
              {detail.result === "ok" ? "成功" : detail.result === "denied" ? "拒绝" : "错误"}
            </div>
          </Field>
          <Field label="资源类型"><TextInput value={detail.resourceType} readOnly /></Field>
          <Field label="资源名称"><TextInput value={detail.resourceName || "—"} readOnly /></Field>
          <Field label="集群"><TextInput value={detail.clusterId > 0 ? `#${detail.clusterId}` : "平台级"} readOnly /></Field>
          <Field label="动作"><TextInput value={detail.action} readOnly /></Field>
          <Field label="IP 地址"><TextInput value={detail.ip || "—"} readOnly /></Field>
          <Field label="User-Agent"><TextInput value={detail.userAgent || "—"} readOnly /></Field>
        </div>
        {detail.detail && (
          <Field label="详情">
            <pre className="text-[11px] font-mono text-ink-700 bg-subtle border border-line rounded-md p-2.5 whitespace-pre-wrap break-all max-h-[140px] overflow-auto">
              {detail.detail}
            </pre>
          </Field>
        )}
      </div>
    </Modal>
  );
}