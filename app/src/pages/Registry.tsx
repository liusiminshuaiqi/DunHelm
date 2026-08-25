import { useEffect, useMemo, useState } from "react";
import {
  Card, KpiStat, SectionTitle, Modal, Field, TextInput, SelectInput, PrimaryButton, ErrorBanner,
  usePagination, Pagination,
} from "@/components/ui/primitives";
import { useRegistries } from "@/data/useLive";
import {
  createRegistry, deleteRegistry, updateRegistry, testRegistry, registryProjects, createRegistryProject, updateRegistryProject,
  deleteRegistryProject, registryRepos, registryArtifacts, deleteRegistryArtifact,
  deleteRegistryRepository, type RegistryConn, type RegistryProject,
  type RegistryRepo, type RegistryArtifact, type VulnSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Package, Layers, HardDrive, Plus, Globe, Lock, ChevronRight, Trash2, Server, Anchor, ArrowLeft, Search, Copy, Check, Pencil, Plug, CheckCircle2, XCircle, Loader2 } from "lucide-react";

type Filter = "all" | "public" | "private";
const filterLabel: Record<Filter, string> = { all: "全部项目", public: "公开", private: "私有" };
const TYPE_LABEL: Record<string, string> = { harbor: "Harbor", dockerhub: "Docker Hub", acr: "Azure ACR" };
const typeLabel = (t?: string) => TYPE_LABEL[t || ""] || t || "Harbor";

type ConnForm = { name: string; type: string; url: string; username: string; password: string; namespace: string; insecureTls: boolean };

function defaultUrl(t: string): string {
  if (t === "dockerhub") return "https://hub.docker.com";
  return "";
}

// 去掉 registry URL 的协议前缀，得到镜像引用里的 host 部分
function registryHost(url?: string): string {
  return (url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// 完整的镜像引用：镜像仓库地址/镜像名:tag
function imageRef(conn: RegistryConn | null, repo: string, tag: string): string {
  const host = registryHost(conn?.url);
  const t = tag && tag !== "(无 tag)" ? ":" + tag : "";
  return `${host}/${repo}${t}`;
}

function fmtBytes(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (!num || num < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = num;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

function Cve({ v }: { v: VulnSummary }) {
  const items = [
    { k: "C", n: v.critical, c: "bg-err-bg text-err" },
    { k: "H", n: v.high, c: "bg-warn-bg text-warn" },
    { k: "M", n: v.medium, c: "bg-info-bg text-info" },
    { k: "L", n: v.low, c: "bg-ok-bg text-ok" },
  ].filter((x) => x.n > 0);
  if (!items.length) return <span className="text-[10px] text-ink-300 font-mono">无漏洞</span>;
  return (
    <div className="flex items-center gap-1">
      {items.map((x) => (
        <span key={x.k} className={cn("font-mono text-[9.5px] font-bold px-1 rounded", x.c)}>{x.k}{x.n}</span>
      ))}
    </div>
  );
}

// 公开/私有内联开关
function PubToggle({ pub, disabled, busy, onChange }: { pub: boolean; disabled?: boolean; busy?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={(e) => { e.stopPropagation(); onChange(!pub); }}
      title={disabled ? "该仓库类型不支持通过 API 修改公开/私有" : undefined}
      className={cn(
        "relative inline-flex h-[18px] w-8 items-center rounded-full transition shrink-0",
        pub ? "bg-cyan-500" : "bg-idle",
        (disabled || busy) && "opacity-50 cursor-not-allowed",
      )}
    >
      <span className={cn("inline-block h-[14px] w-[14px] rounded-full bg-white shadow transition-transform", pub ? "translate-x-[15px]" : "translate-x-[2px]")} />
    </button>
  );
}

// 搜索框
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300 pointer-events-none" />
      <TextInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="!h-8 !pl-8 !text-[12px] !w-56"
      />
    </div>
  );
}

// 复制按钮（带已复制反馈）
function CopyBtn({ text, title }: { text: string; title?: string }) {
  const [ok, setOk] = useState(false);
  const on = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 部分环境无 clipboard 权限，降级用临时 textarea
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setOk(true);
    setTimeout(() => setOk(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={on}
      title={title || "复制镜像地址"}
      className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-line bg-surface text-[11px] text-ink-600 hover:bg-sunken hover:border-brand-300 transition"
    >
      {ok ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
      {ok ? "已复制" : "复制"}
    </button>
  );
}

// 镜像版本展平行（仓库 + 版本）
interface ImageRow {
  repo: string;
  tag: string;
  digest: string;
  size: string;
  pushTime: string;
  vuln: VulnSummary;
}

// 按镜像名（repo）合并后的分组
interface ImageGroup {
  repo: string;          // 完整路径 project/repo
  display: string;       // 去掉项目前缀的展示名
  versions: ImageRow[];  // 该镜像下的所有版本（tag）
}

export function Registry() {
  const { data: conns, reload: reloadConns } = useRegistries();
  const [selReg, setSelReg] = useState<string>(() => localStorage.getItem("dunhelm.registry") || "");
  const [projects, setProjects] = useState<RegistryProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [connOpen, setConnOpen] = useState(false);
  const [editConn, setEditConn] = useState<RegistryConn | null>(null);
  const [projOpen, setProjOpen] = useState(false);
  const [projName, setProjName] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [projSearch, setProjSearch] = useState("");
  const [busyId, setBusyId] = useState<string>("");

  // 删除项目确认弹窗
  const [confirmDel, setConfirmDel] = useState<{ open: boolean; name: string; repoCount: number }>({ open: false, name: "", repoCount: 0 });
  const [delBusy, setDelBusy] = useState(false);

  // 删除镜像确认弹窗（level: repo=整个镜像名；tag=单个版本）
  const [confirmImg, setConfirmImg] = useState<{ open: boolean; level: "repo" | "tag"; project: string; repo: string; display: string; tag: string; digest: string }>({ open: false, level: "tag", project: "", repo: "", display: "", tag: "", digest: "" });
  const [delImgBusy, setDelImgBusy] = useState(false);

  // 子页面（项目详情）
  const [view, setView] = useState<"list" | "detail">("list");
  const [active, setActive] = useState<RegistryProject | null>(null);
  const [repos, setRepos] = useState<RegistryRepo[]>([]);
  const [images, setImages] = useState<ImageRow[]>([]);
  const [detLoading, setDetLoading] = useState(false);
  const [detErr, setDetErr] = useState("");
  const [imgSearch, setImgSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const selConn = conns.find((c) => String(c.id) === selReg) || null;
  const canCreate = selConn?.type === "harbor";
  const canToggle = selConn?.type === "harbor";
  const canDelete = selConn?.type === "harbor";

  // 总仓库数
  const totalRepos = projects.reduce((a, p) => a + p.repoCount, 0);
  // 已使用存储：直接对 ListProjects 返回的 quotaUsed 字段累加（后端 Harbor 用
  // GET /projects/{name}/summary 一次 RTT 填充，不再需要逐项目并发轮询）。
  const realUsed = projects.reduce((a, p) => a + (p.quotaUsed || 0), 0);

  // 默认选中第一个连接
  useEffect(() => {
    if (!selReg && conns.length > 0) {
      const id = String(conns[0].id);
      setSelReg(id);
      localStorage.setItem("dunhelm.registry", id);
    }
  }, [conns, selReg]);

  const loadProjects = async (rid: string) => {
    if (!rid) { setProjects([]); return; }
    setLoading(true); setErr("");
    try {
      const ps = await registryProjects(rid);
      setProjects(ps);
    } catch (e: any) {
      setErr(e?.message || "加载项目失败");
      setProjects([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { loadProjects(selReg); /* eslint-disable-next-line */ }, [selReg]);

  // 项目过滤 + 搜索 + 分页
  const projFiltered = projects
    .filter((p) => filter === "all" || (filter === "public" ? p.public : !p.public))
    .filter((p) => p.name.toLowerCase().includes(projSearch.trim().toLowerCase()));
  const projPag = usePagination(projFiltered.length, 9);
  useEffect(() => { projPag.setPage(1); }, [projSearch, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // 按镜像名（repo）合并版本，形成分组
  const groups = useMemo<ImageGroup[]>(() => {
    const m = new Map<string, ImageRow[]>();
    for (const im of images) {
      const arr = m.get(im.repo) || [];
      arr.push(im);
      m.set(im.repo, arr);
    }
    return Array.from(m.entries()).map(([repo, versions]) => ({
      repo,
      display: repo.replace(/^[^/]+\//, ""),
      versions,
    }));
  }, [images]);

  // 详情页已加载全部镜像：按 digest 去重累加真实存储用量
  const usedStorage = useMemo(() => {
    const seen = new Set<string>(); let s = 0;
    for (const im of images) {
      if (!seen.has(im.digest)) { seen.add(im.digest); s += Number(im.size) || 0; }
    }
    return s;
  }, [images]);

  // 镜像过滤（按镜像名或版本 tag）+ 分页（按分组）
  const imgFiltered = groups.filter((g) => {
    const q = imgSearch.trim().toLowerCase();
    if (!q) return true;
    return g.repo.toLowerCase().includes(q) || g.versions.some((v) => v.tag.toLowerCase().includes(q) || v.digest.toLowerCase().includes(q));
  });
  const imgPag = usePagination(imgFiltered.length, 10);
  useEffect(() => { imgPag.setPage(1); }, [imgSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts: Record<Filter, number> = {
    all: projects.length,
    public: projects.filter((p) => p.public).length,
    private: projects.filter((p) => !p.public).length,
  };

  const saveConn = async (form: ConnForm, editing: RegistryConn | null) => {
    if (editing) {
      await updateRegistry(editing.id, { ...form });
    } else {
      await createRegistry({ ...form });
    }
    setConnOpen(false);
    setEditConn(null);
    reloadConns();
  };
  const removeConn = async (id: number) => {
    await deleteRegistry(id);
    if (String(id) === selReg) { setSelReg(""); localStorage.removeItem("dunhelm.registry"); }
    reloadConns();
  };

  const saveProj = async (form: { name: string; public: boolean }) => {
    if (!selReg) return;
    await createRegistryProject(selReg, form);
    setProjOpen(false);
    setProjName("");
    loadProjects(selReg);
  };

  // 切换公开 / 私有
  const togglePub = async (p: RegistryProject, next: boolean) => {
    if (!selReg || !canToggle) return;
    const key = String(p.id ?? p.name);
    setBusyId(key);
    try {
      await updateRegistryProject(selReg, p.name, next);
      setProjects((prev) => prev.map((x) => (String(x.id ?? x.name) === key ? { ...x, public: next } : x)));
      if (active && String(active.id ?? active.name) === key) setActive({ ...active, public: next });
    } catch (e: any) {
      setErr(e?.message || "修改公开/私有失败");
    } finally { setBusyId(""); }
  };

  // 删除项目
  const openDel = (p: RegistryProject) => setConfirmDel({ open: true, name: p.name, repoCount: p.repoCount });
  const confirmDelProj = async () => {
    if (!selReg) return;
    setDelBusy(true);
    try {
      await deleteRegistryProject(selReg, confirmDel.name);
      setConfirmDel({ open: false, name: "", repoCount: 0 });
      if (active && active.name === confirmDel.name) { setView("list"); setActive(null); setImages([]); setRepos([]); }
      await loadProjects(selReg);
    } catch (e: any) {
      setErr(e?.message || "删除项目失败");
    } finally { setDelBusy(false); }
  };

  // 进入项目子页面：并发拉取所有仓库与版本，展平为镜像列表
  const openDetail = async (p: RegistryProject) => {
    setActive(p); setView("detail"); setRepos([]); setImages([]); setImgSearch(""); setDetErr(""); setExpanded({});
    setDetLoading(true);
    try {
      const rs = await registryRepos(selReg, p.name);
      setRepos(rs);
      const flat: ImageRow[] = [];
      await Promise.all(rs.map(async (r) => {
        try {
          const as: RegistryArtifact[] = await registryArtifacts(selReg, p.name, r.repo ?? r.name);
          for (const a of as) {
            if (!a.tags || a.tags.length === 0) {
              flat.push({ repo: r.name, tag: "(无 tag)", digest: a.digest ?? "", size: a.size, pushTime: a.pushTime ?? "", vuln: a.vuln ?? { critical: 0, high: 0, medium: 0, low: 0 } });
            } else {
              for (const t of a.tags) {
                flat.push({ repo: r.name, tag: t.name, digest: a.digest ?? "", size: a.size, pushTime: t.pushTime || a.pushTime || "", vuln: a.vuln ?? { critical: 0, high: 0, medium: 0, low: 0 } });
              }
            }
          }
        } catch { /* 单个仓库失败不影响其它 */ }
      }));
      setImages(flat);
    } catch (e: any) {
      setDetErr(e?.message || "加载仓库失败");
    } finally { setDetLoading(false); }
  };

  const back = () => { setView("list"); setActive(null); setImages([]); setRepos([]); setExpanded({}); };

  // 打开删除镜像确认弹窗：level=repo 删除整个镜像名；level=tag 删除单个版本
  const openDelImg = (level: "repo" | "tag", g: ImageGroup, v?: ImageRow) => {
    if (!active) return;
    setConfirmImg({
      open: true, level, project: active.name, repo: g.repo, display: g.display,
      tag: v?.tag || "", digest: v?.digest || "",
    });
  };
  const confirmDelImg = async () => {
    if (!selReg) return;
    setDelImgBusy(true);
    try {
      if (confirmImg.level === "repo") {
        await deleteRegistryRepository(selReg, confirmImg.project, confirmImg.repo);
        // 乐观移除：该镜像名下全部版本 + 仓库列表中的对应仓库
        setImages((prev) => prev.filter((im) => im.repo !== confirmImg.repo));
        setRepos((prev) => prev.filter((r) => r.name !== confirmImg.repo));
        if (active) setActive({ ...active, repoCount: Math.max(0, active.repoCount - 1) });
      } else {
        await deleteRegistryArtifact(selReg, confirmImg.project, confirmImg.repo, confirmImg.digest);
        // 乐观移除：同一 digest 的版本（同一 artifact 可能挂多个 tag）一并消失
        setImages((prev) => prev.filter((im) => !(im.repo === confirmImg.repo && im.digest === confirmImg.digest)));
      }
      setConfirmImg({ open: false, level: "tag", project: "", repo: "", display: "", tag: "", digest: "" });
    } catch (e: any) {
      setErr(e?.message || "删除镜像失败");
    } finally { setDelImgBusy(false); }
  };

  return (
    <div className="top-aura relative p-5 space-y-4">
      <SectionTitle
        title="镜像仓库"
        desc="多注册中心 · Harbor / Docker Hub / ACR 真实对接"
        right={
          <div className="flex items-center gap-2">
            <SelectInput
              value={selReg}
              onChange={(e) => { setSelReg(e.target.value); localStorage.setItem("dunhelm.registry", e.target.value); }}
              className="!w-auto min-w-[180px]"
            >
              <option value="">— 选择仓库连接 —</option>
              {conns.map((c) => <option key={c.id} value={String(c.id)}>{c.name} · {typeLabel(c.type)}</option>)}
            </SelectInput>
            <button onClick={() => { setEditConn(null); setConnOpen(true); }} className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">
              <Plus size={15} /> 连接
            </button>
            {view === "list" && (
              <button
                onClick={() => canCreate && setProjOpen(true)}
                disabled={!selReg || !canCreate}
                title={!canCreate ? `${typeLabel(selConn?.type)} 不支持通过 API 创建仓库` : undefined}
                className={cn(
                  "flex items-center gap-1.5 h-9 px-3 rounded-lg text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] transition",
                  selReg && canCreate ? "bg-gradient-to-r from-brand-600 to-cyan-500 hover:opacity-95" : "bg-sunken text-ink-400 cursor-not-allowed",
                )}
              >
                <Plus size={15} /> 创建项目
              </button>
            )}
          </div>
        }
      />

      {err && <ErrorBanner msg={err} kind="registry" />}

      {/* 无连接：引导添加 */}
      {conns.length === 0 ? (
        <Card beam={false} className="p-10 text-center">
          <div className="mx-auto w-12 h-12 rounded-[12px] bg-sunken border border-line grid place-items-center mb-3"><Anchor size={22} className="text-brand-600" /></div>
          <div className="text-[13px] font-medium text-ink-800 mb-1">还没有配置镜像仓库连接</div>
          <div className="text-[11.5px] text-ink-400 mb-4">点击右上角「连接」添加一个外部仓库（Harbor / Docker Hub / Azure ACR），支持多个，对应客户的多仓库场景。</div>
          <button onClick={() => setConnOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium">
            <Plus size={15} /> 添加仓库连接
          </button>
        </Card>
      ) : view === "list" ? (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="rise-1"><KpiStat label="仓库连接" value={conns.length} unit="个" icon={<Server size={18} />} accent="brand" /></div>
            <div className="rise-2"><KpiStat label="项目数" value={loading ? "…" : projects.length} unit="个" icon={<Package size={18} />} accent="cyan" /></div>
            <div className="rise-3"><KpiStat label="镜像仓库" value={totalRepos} unit="个" icon={<Layers size={18} />} accent="ok" /></div>
            <div className="rise-4"><KpiStat label="存储使用" value={fmtBytes(realUsed)} unit="" icon={<HardDrive size={18} />} accent="warn" /></div>
          </div>

          {selConn?.type === "harbor" && (
            <Card beam={false} className="px-4 py-2.5 flex items-center gap-2 text-[11px] text-ink-400">
              <HardDrive size={13} className="text-brand-600 shrink-0" />
              存储用量为该项目下全部镜像的真实体积（按 digest 去重累加，来自 Harbor）。本 Harbor 未配置配额，故不显示配额上限。
            </Card>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex p-0.5 bg-sunken rounded-lg border border-line">
              {(Object.keys(filterLabel) as Filter[]).map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-medium transition",
                    filter === f ? "bg-surface text-brand-700 shadow-sh-1" : "text-ink-500 hover:text-ink-900")}>
                  {filterLabel[f]}
                  <span className={cn("font-mono text-[10px] px-1 rounded", filter === f ? "bg-brand-50 text-brand-600" : "bg-line text-ink-400")}>{counts[f]}</span>
                </button>
              ))}
            </div>
            <SearchBox value={projSearch} onChange={setProjSearch} placeholder="搜索项目名称…" />
            <span className="text-[11px] text-ink-400 ml-1">当前连接：<b className="font-mono text-ink-600">{selConn?.name}</b> · {typeLabel(selConn?.type)}</span>
          </div>

          {loading ? (
            <div className="text-[12px] text-ink-400 py-10 text-center">正在从 {typeLabel(selConn?.type)} 加载项目…</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {projPag.slice(projFiltered).map((p, i) => {
                  const key = String(p.id ?? p.name);
                  return (
                    <div key={key} onClick={() => openDetail(p)}
                      className={cn("cursor-pointer shadow-sh-1 hover:shadow-sh-2 hover:-translate-y-px transition", `rise-${(i % 6) + 1}`)}>
                      <Card beam={false} className="p-3.5">
                        <div className="flex items-center gap-2.5 mb-3">
                          <div className="w-9 h-9 rounded-[10px] bg-sunken border border-line grid place-items-center font-mono text-[15px] font-bold text-brand-600 shrink-0">{(p.name[0] ?? "R").toUpperCase()}</div>
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[12.5px] font-semibold text-ink-900 truncate">{p.name}</div>
                            <div className="text-[10px] text-ink-400">{p.repoCount} 个仓库</div>
                          </div>
                          <div className="flex flex-col items-end gap-1" onClick={(e) => e.stopPropagation()}>
                            <PubToggle pub={p.public} disabled={!canToggle} busy={busyId === key} onChange={(v) => togglePub(p, v)} />
                            <span className="text-[9px] text-ink-300 font-mono">{canToggle ? "公开/私有" : "不可改"}</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 py-2.5 border-y border-line mb-2.5 text-center">
                          <div><div className="font-mono text-[15px] font-semibold text-ink-900">{p.repoCount}</div><div className="text-[10px] text-ink-400 mt-0.5">仓库</div></div>
                          <div>
                            <div className="font-mono text-[15px] font-semibold text-ink-900">
                              {selConn?.type !== "harbor" ? "—" : fmtBytes(p.quotaUsed || 0)}
                            </div>
                            <div className="text-[10px] text-ink-400 mt-0.5">已用</div>
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-ink-400">
                          <span className="flex items-center gap-1"><Globe size={11} className={p.public ? "text-cyan-500" : "text-ink-400"} />{p.public ? "公开" : "私有"}</span>
                          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                            {canDelete && (
                              <button onClick={() => openDel(p)} title="删除项目"
                                className="inline-flex items-center gap-1 text-err/80 hover:text-err transition">
                                <Trash2 size={13} /> 删除
                              </button>
                            )}
                            <span className="flex items-center gap-1">查看镜像<ChevronRight size={14} /></span>
                          </div>
                        </div>
                      </Card>
                    </div>
                  );
                })}
              </div>
              {projFiltered.length === 0 && <div className="text-[12px] text-ink-400 py-10 text-center">没有匹配的项目</div>}
              {projFiltered.length > 0 && (
                <Card beam={false}>
                  <Pagination
                    page={projPag.page} totalPages={projPag.totalPages} start={projPag.start} end={projPag.end}
                    total={projPag.total} pageSize={projPag.pageSize}
                    onPageChange={projPag.setPage} onPageSizeChange={projPag.setPageSize}
                  />
                </Card>
              )}
            </>
          )}
        </>
      ) : (
        // ===== 项目子页面：仓库与全部镜像版本 =====
        <div className="space-y-3">
          <button onClick={back} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line bg-surface text-[12px] text-ink-700 hover:bg-sunken transition">
            <ArrowLeft size={14} /> 返回项目列表
          </button>

          <Card beam={false} className="p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-[12px] bg-sunken border border-line grid place-items-center font-mono text-[18px] font-bold text-brand-600 shrink-0">{(active?.name[0] ?? "R").toUpperCase()}</div>
                <div className="min-w-0">
                  <div className="font-mono text-[15px] font-semibold text-ink-900 truncate flex items-center gap-2">
                    {active?.name}
                    {active?.public
                      ? <span className="inline-flex items-center gap-1 text-[10px] font-medium text-cyan-600 bg-cyan-100 px-1.5 py-0.5 rounded"><Globe size={10} />公开</span>
                      : <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-500 bg-idle-bg px-1.5 py-0.5 rounded"><Lock size={10} />私有</span>}
                  </div>
                  <div className="text-[11px] text-ink-400">{repos.length} 个仓库 · {fmtBytes(usedStorage)} 已用 · {detLoading ? "加载中…" : `${images.length} 个版本（${groups.length} 个镜像名）`}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-500">公开</span>
                <PubToggle pub={!!active?.public} disabled={!canToggle} busy={busyId === String(active?.id ?? active?.name)} onChange={(v) => active && togglePub(active, v)} />
                <span className="text-[11px] text-ink-500">私有</span>
                {canDelete && (
                  <button onClick={() => active && openDel(active)} title="删除项目"
                    className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-err/30 text-[12px] text-err hover:bg-err-bg transition ml-1">
                    <Trash2 size={13} /> 删除项目
                  </button>
                )}
                {!canToggle && <span className="text-[10px] text-ink-300">（{typeLabel(selConn?.type)} 不支持 API 修改/删除）</span>}
              </div>
            </div>
          </Card>

          {detErr && <ErrorBanner msg={detErr} kind="registry" />}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <SearchBox value={imgSearch} onChange={setImgSearch} placeholder="搜索镜像名或版本 tag…" />
            <span className="text-[11px] text-ink-400">共 {imgFiltered.length} 个镜像名 · {images.length} 个版本</span>
          </div>

          <Card beam={false} className="overflow-hidden">
            {detLoading ? (
              <div className="text-[12px] text-ink-400 py-12 text-center">正在从 {typeLabel(selConn?.type)} 拉取仓库与镜像…</div>
            ) : repos.length === 0 ? (
              <div className="text-[12px] text-ink-300 py-12 text-center">该项目下暂无仓库</div>
            ) : (
              <>
                <div className="grid grid-cols-[1.6fr_0.7fr_1fr_0.9fr_0.6fr] gap-2 px-4 py-2.5 border-b border-line bg-subtle text-[10.5px] font-medium text-ink-400 uppercase tracking-wide">
                  <div>镜像名</div><div>版本数</div><div>最新推送</div><div>漏洞(汇总)</div><div>操作</div>
                </div>
                <div className="divide-y divide-line max-h-[55vh] overflow-y-auto">
                  {imgPag.slice(imgFiltered).map((g) => {
                    const open = !!expanded[g.repo];
                    // 汇总漏洞
                    const sum = g.versions.reduce((a, v) => ({
                      critical: a.critical + v.vuln.critical, high: a.high + v.vuln.high,
                      medium: a.medium + v.vuln.medium, low: a.low + v.vuln.low,
                    }), { critical: 0, high: 0, medium: 0, low: 0 } as VulnSummary);
                    const latest = g.versions.slice().sort((a, b) => (b.pushTime || "").localeCompare(a.pushTime || ""))[0];
                    return (
                      <div key={g.repo}>
                        <div
                          onClick={() => setExpanded((s) => ({ ...s, [g.repo]: !open }))}
                          className="grid grid-cols-[1.6fr_0.7fr_1fr_0.9fr_0.6fr] gap-2 px-4 py-2.5 items-center hover:bg-sunken/50 cursor-pointer transition"
                        >
                          <div className="min-w-0">
                            <div className="font-mono text-[12px] text-ink-800 truncate" title={g.repo}>{g.display}</div>
                            <div className="text-[10px] text-ink-300 font-mono truncate">{g.repo}</div>
                          </div>
                          <div>
                            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-100">{g.versions.length} 版本</span>
                          </div>
                          <div className="font-mono text-[11px] text-ink-400">{latest?.pushTime?.slice(0, 19)?.replace("T", " ") || "—"}</div>
                          <div><Cve v={sum} /></div>
                          <div className="flex items-center justify-end gap-1">
                            {canDelete && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openDelImg("repo", g); }}
                                title="删除整个镜像（含全部版本）"
                                className="w-7 h-7 grid place-items-center rounded-md border border-line text-ink-400 hover:text-err hover:border-err/30 hover:bg-err-bg transition"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                            <CopyBtn text={imageRef(selConn, g.repo, latest?.tag || "")} title={`复制 ${imageRef(selConn, g.repo, latest?.tag || "")}`} />
                            <ChevronRight size={15} className={cn("text-ink-400 transition-transform", open && "rotate-90")} />
                          </div>
                        </div>
                        {open && (
                          <div className="bg-sunken/40 px-4 pb-2">
                            <div className="text-[10px] text-ink-400 px-0 py-1.5 uppercase tracking-wide">版本 (tag)</div>
                            <div className="space-y-1">
                              {g.versions.map((v, vi) => (
                                <div key={`${v.tag}-${vi}`} className="grid grid-cols-[1.4fr_0.8fr_1fr_0.9fr_0.9fr] gap-2 px-2 py-1.5 items-center rounded-md bg-surface border border-line">
                                  <div className="min-w-0">
                                    <span className="font-mono text-[11.5px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-100 truncate inline-block max-w-full" title={v.tag}>{v.tag}</span>
                                  </div>
                                  <div className="font-mono text-[11px] text-ink-500">{fmtBytes(v.size)}</div>
                                  <div className="font-mono text-[11px] text-ink-400">{v.pushTime?.slice(0, 19)?.replace("T", " ") || "—"}</div>
                                  <div><Cve v={v.vuln} /></div>
                                  <div className="flex justify-end gap-1">
                                    <CopyBtn text={imageRef(selConn, g.repo, v.tag)} title={`复制 ${imageRef(selConn, g.repo, v.tag)}`} />
                                    {canDelete && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); openDelImg("tag", g, v); }}
                                        title="删除该版本"
                                        className="w-7 h-7 grid place-items-center rounded-md border border-line text-ink-400 hover:text-err hover:border-err/30 hover:bg-err-bg transition"
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {imgFiltered.length === 0 && <div className="text-[12px] text-ink-300 py-10 text-center">没有匹配的镜像</div>}
                </div>
                {imgFiltered.length > 0 && (
                  <Pagination
                    page={imgPag.page} totalPages={imgPag.totalPages} start={imgPag.start} end={imgPag.end}
                    total={imgPag.total} pageSize={imgPag.pageSize}
                    onPageChange={imgPag.setPage} onPageSizeChange={imgPag.setPageSize}
                  />
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {/* 添加/编辑连接弹窗 */}
      <ConnModal
        open={connOpen}
        onClose={() => { setConnOpen(false); setEditConn(null); }}
        onSave={saveConn}
        onDelete={removeConn}
        onEdit={(c) => setEditConn(c)}
        conns={conns}
        editing={editConn}
      />

      {/* 创建项目弹窗 */}
      <Modal
        open={projOpen}
        onClose={() => setProjOpen(false)}
        title="创建镜像仓库项目"
        desc={`在 ${selConn?.name || "当前连接"}（${typeLabel(selConn?.type)}）中新建一个项目`}
        icon={<Plus size={15} />}
        footer={
          <>
            <button onClick={() => setProjOpen(false)} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <PrimaryButton onClick={() => projName.trim() && saveProj({ name: projName.trim(), public: false })}>
              创建
            </PrimaryButton>
          </>
        }
      >
        <Field label="项目名称" hint="Harbor project 名"><TextInput value={projName} onChange={(e) => setProjName(e.target.value)} placeholder="my-project" /></Field>
        <p className="text-[11px] text-ink-400">创建后为私有项目；可在项目卡片上直接切换为公开。</p>
      </Modal>

      {/* 删除项目确认弹窗 */}
      <Modal
        open={confirmDel.open}
        onClose={() => !delBusy && setConfirmDel({ open: false, name: "", repoCount: 0 })}
        title="删除镜像仓库项目"
        desc="该操作不可恢复，请确认"
        icon={<Trash2 size={15} />}
        footer={
          <>
            <button onClick={() => setConfirmDel({ open: false, name: "", repoCount: 0 })} disabled={delBusy} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button
              onClick={confirmDelProj}
              disabled={delBusy}
              className="h-9 px-3 rounded-lg bg-err text-white text-[12.5px] font-medium hover:opacity-95 disabled:opacity-50 transition"
            >
              {delBusy ? "删除中…" : "确认删除"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-700">确定要删除项目 <span className="font-mono font-semibold text-ink-900">{confirmDel.name}</span> 吗？</p>
          {confirmDel.repoCount > 0 ? (
            <div className="rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-[11.5px] text-warn">
              该项目下还有 <b className="font-mono">{confirmDel.repoCount}</b> 个仓库（镜像）。删除前请先清空这些仓库内的镜像版本，否则删除会被后端拦截。
            </div>
          ) : (
            <div className="rounded-lg border border-ok/30 bg-ok-bg px-3 py-2 text-[11.5px] text-ok">该项目下没有仓库，可直接删除。</div>
          )}
          <p className="text-[11px] text-ink-400">仅 Harbor 连接支持删除；Docker Hub / ACR 请在对应控制台操作。</p>
        </div>
      </Modal>

      {/* 删除镜像确认弹窗 */}
      <Modal
        open={confirmImg.open}
        onClose={() => !delImgBusy && setConfirmImg({ open: false, level: "tag", project: "", repo: "", display: "", tag: "", digest: "" })}
        title={confirmImg.level === "repo" ? "删除整个镜像" : "删除镜像版本"}
        desc="该操作不可恢复，请确认"
        icon={<Trash2 size={15} />}
        footer={
          <>
            <button onClick={() => setConfirmImg({ open: false, level: "tag", project: "", repo: "", display: "", tag: "", digest: "" })} disabled={delImgBusy} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
            <button
              onClick={confirmDelImg}
              disabled={delImgBusy}
              className="h-9 px-3 rounded-lg bg-err text-white text-[12.5px] font-medium hover:opacity-95 disabled:opacity-50 transition"
            >
              {delImgBusy ? "删除中…" : "确认删除"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {confirmImg.level === "repo" ? (
            <p className="text-[12.5px] text-ink-700">确定要删除镜像 <span className="font-mono font-semibold text-ink-900">{confirmImg.display}</span> 吗？该镜像名下的 <b>全部版本</b> 都会被永久删除。</p>
          ) : (
            <p className="text-[12.5px] text-ink-700">确定要删除镜像 <span className="font-mono font-semibold text-ink-900">{confirmImg.display}</span> 的版本 <span className="font-mono font-semibold text-ink-900">{confirmImg.tag}</span> 吗？若同一镜像版本挂了多个 tag，会一并删除。</p>
          )}
          <div className="rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-[11.5px] text-warn">
            删除后将无法恢复；若该版本正被 Pod / 部署引用，请先确认再操作。
          </div>
          <p className="text-[11px] text-ink-400">仅 Harbor 连接支持删除；Docker Hub / ACR 请在对应控制台操作。</p>
        </div>
      </Modal>
    </div>
  );
}

function ConnModal({ open, onClose, onSave, onDelete, onEdit, conns, editing }: {
  open: boolean; onClose: () => void;
  onSave: (f: ConnForm, editing: RegistryConn | null) => void;
  onDelete: (id: number) => void;
  onEdit: (c: RegistryConn) => void;
  conns: RegistryConn[];
  editing: RegistryConn | null;
}) {
  const [f, setF] = useState<ConnForm>({ name: "", type: "harbor", url: "", username: "", password: "", namespace: "", insecureTls: false });
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState<{ ok: boolean; error?: string; latencyMs?: number } | null>(null);
  const set = (k: keyof ConnForm) => (e: any) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const onType = (t: string) => setF((s) => ({ ...s, type: t, url: s.url || defaultUrl(t) }));

  // 打开时按 editing 预填表单（编辑模式回填现有配置，密码为解密明文）
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setF({
        name: editing.name, type: editing.type, url: editing.url,
        username: editing.username ?? "", password: editing.password || "",
        namespace: editing.namespace || "", insecureTls: !!editing.insecureTls,
      });
    } else {
      setF({ name: "", type: "harbor", url: "", username: "", password: "", namespace: "", insecureTls: false });
    }
    setTestRes(null);
  }, [open, editing]);

  const testConn = async () => {
    setTesting(true); setTestRes(null);
    try {
      const r = await testRegistry({ ...f, id: editing?.id });
      setTestRes(r);
    } catch (e: any) {
      setTestRes({ ok: false, error: e?.message || "测试失败" });
    } finally { setTesting(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "编辑镜像仓库连接" : "镜像仓库连接"}
      desc={editing ? `修改连接「${editing.name}」的配置` : "配置一个外部仓库连接（可添加多个）"}
      icon={<Anchor size={15} />}
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          <button
            onClick={testConn}
            disabled={testing || !f.url}
            className={cn(
              "h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition inline-flex items-center gap-1.5",
              (!f.url || testing) && "opacity-50 cursor-not-allowed",
            )}
          >
            {testing ? <><Loader2 size={13} className="animate-spin" /> 测试中…</> : <><Plug size={13} /> 测试连接</>}
          </button>
          <PrimaryButton onClick={() => onSave(f, editing)}>{editing ? "保存修改" : "保存连接"}</PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="连接名称"><TextInput value={f.name} onChange={set("name")} placeholder="生产 Harbor" /></Field>
        <Field label="类型">
          <SelectInput value={f.type} onChange={(e) => onType(e.target.value)}>
            <option value="harbor">Harbor</option>
            <option value="dockerhub">Docker Hub</option>
            <option value="acr">Azure ACR</option>
          </SelectInput>
        </Field>
        <Field label="地址" hint={f.type === "dockerhub" ? "默认 hub.docker.com，可改" : f.type === "acr" ? "登录服务器，如 myregistry.azurecr.io" : "https://harbor.example.com"}>
          <TextInput value={f.url} onChange={set("url")} placeholder={defaultUrl(f.type) || "https://harbor.example.com"} />
        </Field>
        <Field label="命名空间" hint={f.type === "dockerhub" ? "Docker Hub 的 org / 用户（必填）" : f.type === "acr" ? "ACR 无需命名空间" : "可选"}>
          {f.type === "dockerhub"
            ? <TextInput value={f.namespace} onChange={set("namespace")} placeholder="library" />
            : <TextInput value={f.namespace} onChange={set("namespace")} disabled placeholder={f.type === "acr" ? "ACR 无需命名空间" : "可选"} />}
        </Field>
        <Field label="用户名"><TextInput value={f.username} onChange={set("username")} placeholder={f.type === "dockerhub" ? "Docker ID 或访问令牌" : "admin"} /></Field>
        <Field label="密码" hint={editing ? "留空表示不修改密码" : undefined}>
          <TextInput type="password" value={f.password} onChange={set("password")} placeholder={editing ? "••••••（不修改请留空）" : "••••••"} />
        </Field>
        {f.type === "harbor" && (
          <label className="flex items-center gap-2 text-[11.5px] text-ink-600 cursor-pointer">
            <input type="checkbox" checked={f.insecureTls} onChange={set("insecureTls")} className="accent-brand-600" />
            跳过 TLS 证书校验（自签 Harbor）
          </label>
        )}

        {testRes && (
          <div className={cn("rounded-lg border px-3 py-2 text-[11.5px] flex items-center gap-2", testRes.ok ? "border-ok/30 bg-ok-bg text-ok" : "border-err/30 bg-err-bg text-err")}>
            {testRes.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {testRes.ok ? `连接成功（耗时 ${testRes.latencyMs ?? 0} ms）` : `连接失败：${testRes.error}`}
          </div>
        )}

        {conns.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="text-[11px] text-ink-400 mb-2">已配置的连接</div>
            <div className="space-y-1.5">
              {conns.map((c) => (
                <div key={c.id} className={cn("flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-sunken border", c.id === editing?.id ? "border-brand-300" : "border-line")}>
                  <div className="min-w-0">
                    <div className="font-mono text-[11.5px] text-ink-800 truncate">{c.name} · <span className="opacity-60">{typeLabel(c.type)}</span></div>
                    <div className="text-[10px] text-ink-400 truncate">{c.url}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => onEdit(c)} className="w-7 h-7 grid place-items-center rounded-md hover:bg-brand-50 text-ink-400 hover:text-brand-600 transition" title="编辑连接">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => c.id !== undefined && onDelete(c.id)} className="w-7 h-7 grid place-items-center rounded-md hover:bg-err-bg text-ink-400 hover:text-err transition" title="删除连接">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
