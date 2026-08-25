// ImagePicker —— 「从镜像仓库选择镜像」组件
//
// 用法：在创建/升级 Deployment 表单的"镜像"字段位置使用。它本身是一个组合控件：
//   <ImagePicker value={form.image} onChange={set("image")} placeholder="..." />
// 渲染出一个 TextInput + 右侧「从镜像仓库选择」按钮。
//   - 用户可直接在输入框里手填镜像（兼容既有行为）。
//   - 或点击按钮打开三级联选 Modal：连接 → 项目 → 仓库 + tag，
//     选完自动回填「host/project/repo:tag」到 TextInput。
//
// 与"手动键入"并列存在：两种方式互不锁定，文本框始终可编辑。

import { useEffect, useMemo, useState } from "react";
import {
  Package, Search, Database, ChevronRight, RefreshCw, Box, Server, Filter,
} from "lucide-react";
import { Modal, Pagination, usePagination } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  registryProjects, registryRepos, registryArtifacts,
  type RegistryConn, type RegistryProject, type RegistryRepo, type RegistryArtifact,
} from "@/lib/api";
import { useRegistries } from "@/data/useLive";

function registryHost(url?: string): string {
  return (url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// 把"连接 + 项目 + 仓库 + tag"合成一个完整的容器镜像引用。
//   - Harbor：host/project/repo:tag（项目作为镜像前缀一部分）
//   - Docker Hub：host/repo:tag（无项目概念）
//   - ACR：host/repo:tag（无项目概念）
function buildImageRef(conn: RegistryConn | null, proj: string | null, repo: string, tag: string): string {
  const host = registryHost(conn?.url) || (conn?.type === "dockerhub" ? "hub.docker.com" : conn?.type === "acr" ? (conn?.url || "") : "");
  const path = conn?.type === "harbor" && proj ? `${proj}/${repo}` : repo;
  const t = tag ? `:${tag}` : "";
  return `${host}/${path}${t}`;
}

export function ImagePicker({
  value, onChange, placeholder, disabled, className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder || "registry.local/namespace/image:tag"}
        className="w-full h-9 pl-3 pr-24 rounded-lg bg-surface border border-line text-[12.5px] font-mono text-ink-900 placeholder:text-ink-300 focus:outline-none focus:border-brand-300 focus:shadow-[0_0_0_3px_rgba(19,96,196,.12)] transition disabled:bg-sunken disabled:cursor-not-allowed"
      />
      <button
        type="button"
        onClick={() => !disabled && setOpen(true)}
        disabled={disabled}
        className={cn(
          "absolute right-1 top-1 h-7 px-2.5 rounded-md border border-line bg-subtle text-[11px] text-ink-600 hover:bg-brand-50 hover:border-brand-200 hover:text-brand-700 transition inline-flex items-center gap-1",
          disabled && "opacity-50 cursor-not-allowed hover:bg-subtle hover:border-line hover:text-ink-600",
        )}
        title="从已对接的镜像仓库选择"
      >
        <Package size={12} /> 选择
      </button>
      <ImagePickerModal
        open={open}
        onClose={() => setOpen(false)}
        onPick={(ref) => { onChange(ref); setOpen(false); }}
      />
    </div>
  );
}

function ImagePickerModal({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (imageRef: string) => void;
}) {
  const { data: conns } = useRegistries() as { data: RegistryConn[] };
  const [connId, setConnId] = useState<string>("");
  const [proj, setProj] = useState<string>("");
  const [repo, setRepo] = useState<string>("");
  const [tag, setTag] = useState<string>("");

  const [projects, setProjects] = useState<RegistryProject[]>([]);
  const [repos, setRepos] = useState<RegistryRepo[]>([]);
  const [artifacts, setArtifacts] = useState<RegistryArtifact[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [projSearch, setProjSearch] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  // 弹窗打开/关闭时重置选择（保留上次的连接方便连续创建）
  useEffect(() => {
    if (open) {
      setProj(""); setRepo(""); setTag("");
      setProjects([]); setRepos([]); setArtifacts([]);
      setProjSearch(""); setRepoSearch("");
      setErr("");
      // 默认选中第一个连接
      if (!connId && conns && conns.length > 0) {
        setConnId(String(conns[0].id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 拉项目
  useEffect(() => {
    if (!open || !connId) { setProjects([]); setProj(""); return; }
    setBusy(true); setErr("");
    registryProjects(connId)
      .then((ps) => { setProjects(ps); setBusy(false); })
      .catch((e) => { setErr(e?.message || "加载项目失败"); setProjects([]); setBusy(false); });
    // 切连接后级联清空
    setProj(""); setRepo(""); setTag("");
    setRepos([]); setArtifacts([]);
  }, [connId, open]);

  // 拉仓库
  useEffect(() => {
    if (!open || !connId || !proj) { setRepos([]); setRepo(""); return; }
    setBusy(true); setErr("");
    registryRepos(connId, proj)
      .then((rs) => { setRepos(rs); setBusy(false); })
      .catch((e) => { setErr(e?.message || "加载仓库失败"); setRepos([]); setBusy(false); });
    setRepo(""); setTag("");
    setArtifacts([]);
  }, [connId, proj, open]);

  // 拉制品（tag）
  useEffect(() => {
    if (!open || !connId || !proj || !repo) { setArtifacts([]); setTag(""); return; }
    setBusy(true); setErr("");
    registryArtifacts(connId, proj, repo)
      .then((as) => {
        setArtifacts(as);
        // 默认选第一个 tag
        for (const a of as) {
          const t = a.tags?.[0]?.name;
          if (t) { setTag(t); break; }
        }
        setBusy(false);
      })
      .catch((e) => { setErr(e?.message || "加载版本失败"); setArtifacts([]); setBusy(false); });
    setTag("");
  }, [connId, proj, repo, open]);

  const conn = useMemo(() => conns?.find((c) => String(c.id) === connId) || null, [conns, connId]);

  const projFiltered = useMemo(() => {
    const q = projSearch.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, projSearch]);

  const repoFiltered = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    return q ? repos.filter((r) => (r.repo || r.name).toLowerCase().includes(q)) : repos;
  }, [repos, repoSearch]);

  const preview = useMemo(() => {
    if (!conn || !repo || !tag) return "";
    return buildImageRef(conn, proj || null, repo, tag);
  }, [conn, proj, repo, tag]);

  const canSubmit = !!(conn && repo && tag);

  const submit = () => {
    if (!canSubmit) return;
    onPick(preview);
  };

  const typeBadge = (t: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      harbor:   { label: "Harbor",    cls: "text-brand-700 bg-brand-50 border-brand-200" },
      dockerhub:{ label: "DockerHub", cls: "text-cyan-700 bg-cyan-50 border-cyan-200" },
      acr:      { label: "ACR",       cls: "text-warn bg-warn-bg border-warn" },
    };
    const m = map[t] ?? map.harbor;
    return (
      <span className={cn("inline-flex items-center gap-1 font-mono text-[10.5px] rounded px-1.5 py-0.5 border whitespace-nowrap", m.cls)}>
        {m.label}
      </span>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="从镜像仓库选择"
      desc="依次选择镜像仓库连接 → 项目 → 仓库 → 版本（tag）；选中的镜像会自动填入表单"
      icon={<Package size={15} />}
      maxW="max-w-3xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={cn(
              "h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition inline-flex items-center gap-1",
              !canSubmit && "opacity-50 cursor-not-allowed hover:opacity-50",
            )}
          >
            应用镜像 <ChevronRight size={13} className="-mt-0.5" />
          </button>
        </>
      }
    >
      {/* 步骤 1：选连接 */}
      <div>
        <div className="flex items-center gap-1.5 text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1.5">
          <Database size={11} /> 1. 镜像仓库
        </div>
        {!conns || conns.length === 0 ? (
          <div className="rounded-lg border border-line bg-subtle px-3 py-2.5 text-[12px] text-ink-500">
            尚未配置任何镜像仓库连接。请到「镜像仓库」页创建一个连接后再来选择。
          </div>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap">
            {conns.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setConnId(String(c.id))}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-[11.5px] transition",
                  String(c.id) === connId
                    ? "border-brand-300 bg-brand-50/70 text-ink-900 shadow-[0_0_0_2px_rgba(19,96,196,.10)]"
                    : "border-line bg-surface text-ink-700 hover:border-brand-200 hover:bg-brand-50/40",
                )}
                title={c.url}
              >
                {typeBadge(c.type)}
                <span className="font-medium">{c.name}</span>
                <span className="font-mono text-[10px] text-ink-400">/{registryHost(c.url)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 步骤 2：选项目（Harbor 才显示；其他类型跳过该步） */}
      {conn && conn.type === "harbor" && (
        <div>
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1.5">
            <Filter size={11} /> 2. 项目
          </div>
          {!proj ? (
            <ProjectList projects={projFiltered} loading={busy} onPick={(n) => setProj(n)} search={projSearch} setSearch={setProjSearch} />
          ) : (
            <div className="flex items-center gap-2 px-3 h-9 rounded-lg bg-brand-50/60 border border-brand-200 text-[12px]">
              <Filter size={13} className="text-brand-600" />
              <span className="font-mono text-ink-900">{proj}</span>
              <button
                type="button"
                onClick={() => setProj("")}
                className="ml-auto text-[10.5px] text-brand-700 hover:underline"
              >
                重选
              </button>
            </div>
          )}
        </div>
      )}

      {/* 步骤 3：选仓库 */}
      {conn && (conn.type !== "harbor" || proj) && (
        <div>
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1.5">
            <Box size={11} /> {conn.type === "harbor" ? "3" : "2"}. 仓库
          </div>
          {!repo ? (
            <RepoList repos={repoFiltered} loading={busy} onPick={(r) => setRepo(r)} search={repoSearch} setSearch={setRepoSearch} />
          ) : (
            <div className="flex items-center gap-2 px-3 h-9 rounded-lg bg-brand-50/60 border border-brand-200 text-[12px]">
              <Box size={13} className="text-brand-600" />
              <span className="font-mono text-ink-900">{repo}</span>
              <button
                type="button"
                onClick={() => setRepo("")}
                className="ml-auto text-[10.5px] text-brand-700 hover:underline"
              >
                重选
              </button>
            </div>
          )}
        </div>
      )}

      {/* 步骤 4：选 tag */}
      {conn && repo && (
        <div>
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1.5">
            <Server size={11} /> {conn.type === "harbor" ? "4" : "3"}. 版本（tag）
          </div>
          <TagList artifacts={artifacts} loading={busy} picked={tag} onPick={setTag} />
        </div>
      )}

      {/* 错误 */}
      {err && (
        <div className="rounded-lg border border-err bg-err-bg/30 px-3 py-2 text-[12px] text-err">
          {err}
        </div>
      )}

      {/* 预览 */}
      {preview && (
        <div className="rounded-lg border border-brand-200 bg-brand-50/40 px-3 py-2 text-[12px]">
          <div className="text-[10.5px] uppercase font-semibold tracking-wider text-brand-700 mb-1">将填入表单的镜像引用</div>
          <div className="font-mono text-[12.5px] text-ink-900 break-all leading-relaxed">{preview}</div>
        </div>
      )}
    </Modal>
  );
}

function ProjectList({
  projects, loading, onPick, search, setSearch,
}: {
  projects: RegistryProject[]; loading: boolean;
  onPick: (n: string) => void;
  search: string; setSearch: (s: string) => void;
}) {
  const pag = usePagination(projects.length, 12);
  useEffect(() => { pag.setPage(1); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounded-lg border border-line overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-subtle focus-within:border-brand-300">
        <Search size={14} className="text-ink-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-transparent outline-none text-[12px] w-full placeholder:text-ink-300"
          placeholder="按项目名筛选…"
        />
        <span className="font-mono text-[10.5px] text-ink-400 whitespace-nowrap">{projects.length}</span>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {loading && projects.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-6 text-ink-400 text-[12px] justify-center">
            <RefreshCw size={14} className="animate-spin" /> 加载中…
          </div>
        ) : projects.length === 0 ? (
          <div className="px-3 py-6 text-center text-ink-400 text-[12px]">无匹配项目</div>
        ) : projects.slice(pag.start, pag.end).map((p) => (
          <button
            key={p.id || p.name}
            type="button"
            onClick={() => onPick(p.name)}
            className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-brand-50/40 border-t border-line/70 first:border-t-0 transition"
          >
            <Filter size={12} className="text-brand-500 shrink-0" />
            <span className="font-mono text-[12px] text-ink-900 truncate">{p.name}</span>
            <span className="font-mono text-[10px] text-ink-400 ml-auto">{p.repoCount} 仓库</span>
            <ChevronRight size={12} className="text-ink-300" />
          </button>
        ))}
      </div>
      {pag.totalPages > 1 && (
        <Pagination {...pag} onPageChange={pag.setPage} onPageSizeChange={pag.setPageSize} />
      )}
    </div>
  );
}

function RepoList({
  repos, loading, onPick, search, setSearch,
}: {
  repos: RegistryRepo[]; loading: boolean;
  onPick: (name: string) => void;
  search: string; setSearch: (s: string) => void;
}) {
  const pag = usePagination(repos.length, 10);
  useEffect(() => { pag.setPage(1); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounded-lg border border-line overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-subtle focus-within:border-brand-300">
        <Search size={14} className="text-ink-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-transparent outline-none text-[12px] w-full placeholder:text-ink-300"
          placeholder="按仓库名筛选…"
        />
        <span className="font-mono text-[10.5px] text-ink-400 whitespace-nowrap">{repos.length}</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {loading && repos.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-6 text-ink-400 text-[12px] justify-center">
            <RefreshCw size={14} className="animate-spin" /> 加载中…
          </div>
        ) : repos.length === 0 ? (
          <div className="px-3 py-6 text-center text-ink-400 text-[12px]">项目下还没有仓库（请先 docker push）</div>
        ) : repos.slice(pag.start, pag.end).map((r) => {
          const name = r.repo || r.name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => onPick(name)}
              className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-brand-50/40 border-t border-line/70 first:border-t-0 transition"
            >
              <Box size={12} className="text-brand-500 shrink-0" />
              <span className="font-mono text-[12px] text-ink-900 truncate">{name}</span>
              <span className="font-mono text-[10px] text-ink-400 ml-auto">{r.artifactCount} 版本</span>
              <ChevronRight size={12} className="text-ink-300" />
            </button>
          );
        })}
      </div>
      {pag.totalPages > 1 && (
        <Pagination {...pag} onPageChange={pag.setPage} onPageSizeChange={pag.setPageSize} />
      )}
    </div>
  );
}

function TagList({
  artifacts, loading, picked, onPick,
}: {
  artifacts: RegistryArtifact[]; loading: boolean;
  picked: string; onPick: (t: string) => void;
}) {
  // 拉平 artifact.tag 列表
  const tags = useMemo(() => {
    const out: { tag: string; digest: string; size: string; pushTime: string }[] = [];
    for (const a of artifacts) {
      if (!a.tags || a.tags.length === 0) continue;
      for (const t of a.tags) {
        out.push({ tag: t.name, digest: a.digest ?? "", size: a.size, pushTime: t.pushTime || a.pushTime || "" });
      }
    }
    out.sort((x, y) => (y.pushTime || "").localeCompare(x.pushTime || ""));
    return out;
  }, [artifacts]);

  return (
    <div className="rounded-lg border border-line overflow-hidden">
      <div className="max-h-[200px] overflow-y-auto">
        {loading && tags.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-6 text-ink-400 text-[12px] justify-center">
            <RefreshCw size={14} className="animate-spin" /> 加载中…
          </div>
        ) : tags.length === 0 ? (
          <div className="px-3 py-6 text-center text-ink-400 text-[12px]">仓库下还没有任何 tag</div>
        ) : tags.map((t) => (
          <button
            key={`${t.digest}-${t.tag}`}
            type="button"
            onClick={() => onPick(t.tag)}
            className={cn(
              "w-full text-left flex items-center gap-2 px-3 py-2 border-t border-line/70 first:border-t-0 transition",
              picked === t.tag ? "bg-brand-50/70" : "hover:bg-brand-50/40",
            )}
          >
            <input type="radio" checked={picked === t.tag} onChange={() => onPick(t.tag)} className="accent-brand-600" />
            <span className="font-mono text-[12px] text-ink-900">{t.tag}</span>
            <span className="font-mono text-[10px] text-ink-400 truncate ml-auto" title={t.digest}>
              {t.size} · {t.pushTime ? new Date(t.pushTime).toLocaleString() : "—"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function fmtBytesLocal(n: number): string {
  if (!n || n < 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}
// 保留供未来重新启用（显示字节）
void fmtBytesLocal;