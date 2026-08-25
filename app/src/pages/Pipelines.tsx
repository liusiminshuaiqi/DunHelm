import { Fragment, useEffect, useRef, useState } from "react";
import {
  Card, CardHead, StatusBadge, SectionTitle, BuildHistoryStrip, Modal, Field, TextInput, SelectInput, LineNumberedTextArea,
} from "@/components/ui/primitives";
import { ImagePicker } from "@/components/ImagePicker";
import {
  ContainerPortsEditor, EnvVarsEditor, VolumeMountsEditor, ProbesEditor, NamespaceSelect, RegistrySelect, ClusterSelect,
} from "@/components/DeployConfigEditors";
import type { PipelineNav } from "@/App";
import { type Pipeline, type Build as MockBuild, type StatusKind } from "@/data/mock";
import { usePipelines } from "@/data/useLive";
import { getCluster } from "@/lib/cluster";
import {
  listBuilds, runPipeline, abortBuild, deletePipeline,
  createPipeline, updatePipeline, getPipelineDetail, getBuild,
  getBuildRetention, saveBuildRetention,
  updatePipelineStages, uploadPipelinePackage, probeGitRepo,
  type BuildRow, type BuildListResp, type PipelineRow, type PipelineDetailResp, type PipelineStageDef,
  type PipelineNodeKind,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Check, Loader2, X, GitBranch, Clock, Zap, Plus, Square,
  Trash2, Pencil, Play, ChevronRight, ChevronLeft, ListTree, Layers, Copy,
  Package as PackageIcon, Box as BoxIcon,
  Container, ServerCog, BellRing, Hourglass, Hammer,
  Boxes, Workflow, ArrowLeft, UploadCloud,
  FileText,
} from "lucide-react";

// 把后端 string 状态映射成前端 StatusKind（用于 StatusBadge）
function toStatusKind(s: string | undefined): StatusKind {
  if (s === "ok") return "ok";
  if (s === "running") return "running";
  if (s === "err") return "err";
  if (s === "aborted") return "warn";
  return "info";
}

// 阶段颜色（不依赖 StatusKind，统一按字符串控制）
const stageColor: Record<string, string> = {
  ok:       "border-ok/35 bg-[linear-gradient(180deg,#F5FDF9,#fff)]",
  running:  "border-brand-300 shadow-glow bg-[linear-gradient(180deg,#EFF6FE,#fff)]",
  pending:  "bg-subtle border-dashed border-line-strong",
  err:      "border-err/40 bg-[linear-gradient(180deg,#FDEAE9,#fff)]",
  aborted:  "bg-subtle border-line-strong",
};
const stageText: Record<string, string> = {
  ok: "已完成", running: "执行中 …", pending: "等待中", err: "失败", aborted: "已中止",
};

export function Pipelines({
  nav, onNav,
}: { nav: PipelineNav; onNav: (n: PipelineNav) => void }) {
  // 三种视图均为整页（不再用 Modal 弹窗）：
  //   list   — 列表卡片 + 构建记录表
  //   new    — 创建流水线（子页）
  //   detail — 详情（含 6 个 Tab：基本/阶段/触发源/构建历史/运行/编排）
  if (nav.kind === "new") {
    return <PipelineEditorPage onNav={onNav} onCreated={() => onNav({ kind: "list" })} />;
  }
  if (nav.kind === "detail") {
    return <PipelineDetailPage name={nav.name} tab={nav.tab} onNav={onNav} />;
  }
  return <PipelineListView onNav={onNav} />;
}

// ---------- 列表页 ----------
function PipelineListView({ onNav }: { onNav: (n: PipelineNav) => void }) {
  const pipelinesHook = usePipelines();
  const pipelines: Pipeline[] = (pipelinesHook.data ?? []) as Pipeline[];
  const reloadPipelines = pipelinesHook.reload;
  const running = pipelines.find((p) => p.lastStatus === "running");

  const allBuildsHook = useAllBuilds();
  const recentBuilds: MockBuild[] = allBuildsHook.data as unknown as MockBuild[];

  return (
    <div className="top-aura relative p-5 space-y-4">
      <SectionTitle
        title="流水线"
        desc="CI / CD 持续交付流水线 · 自研 CI 引擎"
        right={
          <button
            onClick={() => onNav({ kind: "new" })}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition"
          >
            <Plus size={15} /> 创建流水线
          </button>
        }
      />

      {/* 当前运行（仅当存在真正 running 流水线时显示，避免与下方网格重复） */}
      {running && (
        <Card>
          <CardHead
            title="运行中"
            sub={`${running.name} · ${running.repo} · ${running.branch}`}
            right={
              <div className="flex items-center gap-2.5">
                <StatusBadge kind={toStatusKind(running.lastStatus)} label="RUNNING" />
                <span className="font-mono text-[11px] text-ink-400 flex items-center gap-1">
                  <Clock size={11} />已耗时 {running.duration}
                </span>
                <button
                  onClick={() => onNav({ kind: "detail", name: running.name, tab: "basic" })}
                  className="h-7 px-2.5 rounded-md border border-line bg-surface text-[11.5px] text-ink-700 flex items-center gap-1 hover:border-brand-300 hover:text-brand-700 transition"
                >
                  查看详情 <ChevronRight size={11} />
                </button>
              </div>
            }
          />
          <div className="px-4 pb-4">
            <StageFlow stages={(running.stages as unknown) as { name: string; status: string }[]} />
          </div>
        </Card>
      )}

      {/* 流水线列表 */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <h3 className="text-[13.5px] font-semibold text-ink-900 flex items-center gap-1.5">
          <Boxes size={14} className="text-brand-600" /> 流水线列表
        </h3>
        <span className="text-[11px] text-ink-400">{pipelines.length} 条</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {pipelines.map((p, i) => (
          <PipelineCard
            key={p.name}
            p={p as unknown as PipelineRow}
            idx={i}
            onOpen={() => onNav({ kind: "detail", name: p.name, tab: "basic" })}
            onRun={async () => {
              await runPipeline(p.name);
              reloadPipelines();
              allBuildsHook.reload();
            }}
            onChanged={() => { reloadPipelines(); allBuildsHook.reload(); }}
          />
        ))}
      </div>

      {/* 构建记录表 */}
      <Card beam={false}>
        <CardHead title="构建记录" sub="最近 10 次构建" />
        <div className="px-2 pb-2 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-ink-400 text-[10.5px] font-semibold uppercase tracking-wider">
                <th className="text-left font-semibold px-3 py-2.5 bg-subtle border-b border-line">构建</th>
                <th className="text-left font-semibold px-3 py-2.5 bg-subtle border-b border-line">流水线</th>
                <th className="text-left font-semibold px-3 py-2.5 bg-subtle border-b border-line">状态</th>
                <th className="text-left font-semibold px-3 py-2.5 bg-subtle border-b border-line">分支</th>
                <th className="text-left font-semibold px-3 py-2.5 bg-subtle border-b border-line">触发</th>
                <th className="text-right font-semibold px-3 py-2.5 bg-subtle border-b border-line">耗时</th>
                <th className="text-right font-semibold px-3 py-2.5 bg-subtle border-b border-line">时间</th>
              </tr>
            </thead>
            <tbody>
              {(recentBuilds ?? []).map((r) => (
                <tr
                  key={r.id}
                  onClick={() => onNav({ kind: "detail", name: r.pipeline, tab: "builds" })}
                  className="border-b border-line last:border-0 hover:bg-brand-50/60 transition cursor-pointer"
                >
                  <td className="px-3 py-2 font-mono text-ink-900">{r.id}</td>
                  <td className="px-3 py-2 font-mono text-ink-700">{r.pipeline}</td>
                  <td className="px-3 py-2"><StatusBadge kind={toStatusKind(r.status)} label={r.status === "ok" ? "SUCCESS" : r.status === "running" ? "RUNNING" : r.status === "err" ? "FAILED" : "ABORTED"} /></td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-500">{r.branch}</td>
                  <td className="px-3 py-2 text-ink-500">{r.trigger}</td>
                  <td className="px-3 py-2 text-right font-mono text-ink-700 tabular-nums">{r.duration}</td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-400">{r.time}</td>
                </tr>
              ))}
              {(!recentBuilds || recentBuilds.length === 0) && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-ink-400 text-[12px]">暂无构建记录 · 点卡片「运行」开始第一次构建</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------- 顶部全量构建记录 hook ----------
function useAllBuilds() {
  const [data, setData] = useState<MockBuild[]>([]);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    let alive = true;
    listBuilds({ page: 1, pageSize: 10 })
      .then((resp: BuildListResp) => {
        if (!alive) return;
        setData((resp.list ?? []).map((r) => ({
          id: r.id, pipeline: r.pipeline, status: r.status as StatusKind,
          branch: r.branch, trigger: r.trigger, duration: r.duration, time: r.time,
        })));
      })
      .catch(() => alive && setData([]));
    return () => { alive = false; };
  }, [tick]);
  return { data, reload };
}

// ---------- 阶段流程图 ----------
function StageFlow({ stages }: { stages: { name: string; status: string }[] }) {
  return (
    <div className="flex items-stretch gap-0 overflow-x-auto px-4 pb-4">
      {stages.map((s, i) => (
        <Fragment key={s.name + i}>
          <div className={cn("min-w-[148px] flex-1 border rounded-xl p-3 transition", stageColor[s.status] || stageColor.pending)}>
            <div className="flex items-center gap-2 mb-1.5">
              <StageDot status={s.status} />
              <strong className={cn("text-[12px] font-semibold", s.status === "pending" || s.status === "aborted" ? "text-ink-500" : "text-ink-900")}>{s.name}</strong>
            </div>
            <small className="font-mono text-[10.5px] text-ink-400 block">{stageText[s.status] || s.status}</small>
            <div className="h-[3px] rounded-full bg-sunken mt-2 overflow-hidden">
              <div
                className={cn("h-full rounded-full",
                  s.status === "running" ? "bg-gradient-to-r from-brand-500 to-cyan-400 animate-pulse" :
                  s.status === "pending" || s.status === "aborted" ? "bg-transparent" :
                  s.status === "err" ? "bg-err" : "bg-ok")}
                style={{ width: s.status === "ok" ? "100%" : s.status === "err" ? "100%" : s.status === "running" ? "66%" : "0%" }}
              />
            </div>
          </div>
          {i < stages.length - 1 && (
            <div className={cn("flex-none w-[26px] self-center h-0.5",
              s.status === "ok" ? "bg-gradient-to-r from-ok to-ok/40" :
              s.status === "running" ? "bg-gradient-to-r from-brand-500 to-line-strong" :
              "bg-line-strong")} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function StageDot({ status }: { status: string }) {
  if (status === "ok") return <span className="w-[18px] h-[18px] rounded-full bg-ok text-white grid place-items-center"><Check size={11} strokeWidth={3} /></span>;
  if (status === "running") return <span className="w-[18px] h-[18px] rounded-full bg-brand-600 text-white grid place-items-center ring-4 ring-brand-500/15 animate-pulse-ring"><Loader2 size={11} className="animate-spin-slow" /></span>;
  if (status === "err") return <span className="w-[18px] h-[18px] rounded-full bg-err text-white grid place-items-center"><X size={11} strokeWidth={3} /></span>;
  return <span className="w-[18px] h-[18px] rounded-full bg-sunken border border-line-strong text-ink-300 grid place-items-center"><span className="w-1.5 h-1.5 rounded-full bg-ink-300" /></span>;
}

// ---------- 流水线卡片 ----------
function PipelineCard({
  p, idx, onOpen, onRun, onChanged,
}: { p: PipelineRow; idx: number; onOpen: () => void; onRun: () => void; onChanged: () => void }) {
  return (
    <div className={cn(
      "group bg-surface rounded-lg border border-line shadow-sh-1 p-3.5 transition duration-200 hover:shadow-sh-2 hover:border-brand-300 hover:-translate-y-px",
      `rise-${(idx % 6) + 1}`,
    )}>
      <div className="flex items-start gap-2.5 mb-2.5 cursor-pointer" onClick={onOpen}>
        <div className="w-8 h-8 rounded-lg grid place-items-center bg-gradient-to-br from-brand-50 to-cyan-100 border border-line text-brand-600 shrink-0">
          <GitBranch size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] font-semibold text-ink-900 truncate">{p.name}</div>
          <div className="font-mono text-[10.5px] text-ink-400 truncate">{p.repo} · {p.branch} · 触发：{p.trigger}</div>
        </div>
        <StatusBadge
          kind={toStatusKind(p.lastStatus)}
          label={p.lastStatus === "ok" ? "SUCCESS" : p.lastStatus === "running" ? "RUNNING" : p.lastStatus === "err" ? "FAILED" : "IDLE"}
        />
      </div>

      <BuildHistoryStrip statuses={p.recentBuilds ?? []} />

      <div className="mt-2.5 pt-2.5 border-t border-line flex items-center gap-3.5 text-[11px] text-ink-400 font-mono">
        <span className="flex items-center gap-1"><Clock size={11} />{p.duration}</span>
        <span className="flex items-center gap-1"><Zap size={11} />{p.lastStatus === "err" ? "0%" : "92%"}</span>
        <span className="flex items-center gap-1"><Layers size={11} />{p.stages.length} 阶段</span>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          onClick={onRun}
          disabled={p.lastStatus === "running"}
          className="flex-1 h-8 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[11.5px] font-medium flex items-center justify-center gap-1 shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50"
        >
          <Play size={11} /> {p.lastStatus === "running" ? "运行中…" : "运行"}
        </button>
        <button onClick={onOpen} className="h-8 px-2.5 rounded-md border border-line bg-surface text-ink-700 text-[11.5px] flex items-center gap-1 hover:border-brand-300 hover:text-brand-700 transition" title="查看/编辑详情">
          <Pencil size={11} /> 详情
        </button>
        <button onClick={async () => {
          if (!confirm(`确定删除流水线「${p.name}」及其全部构建记录？`)) return;
          await deletePipeline(p.name);
          onChanged();
        }} className="h-8 w-8 grid place-items-center rounded-md border border-line bg-surface text-ink-500 hover:text-err hover:border-err/40 transition" title="删除">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ---------- 创建流水线模板（内置阶段结构，不引用任何已有流水线） ----------
// maven=true 的模板在创建后会携带 Maven 构建配置（settings.xml），其余模板不含。
const PIPELINE_TEMPLATES: {
  id: string; label: string; maven: boolean; builder: "maven" | "npm" | null; desc: string;
  stages: PipelineStageDef[];
}[] = [
  { id: "backend-build",  label: "后端代码编译构建", maven: true,  builder: "maven",
    desc: "git 拉取 → Maven 编译打包 → 单元测试 → 镜像构建 → 部署",
    stages: [
      { name: "Clone",  enabled: true, kind: "git" },
      { name: "Build",  enabled: true, kind: "build" },
      { name: "Test",   enabled: true, kind: "test" },
      { name: "Image",  enabled: true, kind: "docker-build" },
      { name: "Deploy", enabled: true, kind: "deploy" },
    ] },
  { id: "frontend-build", label: "前端代码编译构建", maven: false, builder: "npm",
    desc: "git 拉取 → npm 构建 → 单元测试 → 镜像构建 → 部署",
    stages: [
      { name: "Clone",  enabled: true, kind: "git" },
      { name: "Build",  enabled: true, kind: "build" },
      { name: "Test",   enabled: true, kind: "test" },
      { name: "Image",  enabled: true, kind: "docker-build" },
      { name: "Deploy", enabled: true, kind: "deploy" },
    ] },
  { id: "image-deploy",   label: "已有镜像发布",     maven: false, builder: null,
    desc: "选择已有镜像 → 直接部署",
    stages: [
      { name: "Image",  enabled: true, kind: "image" },
      { name: "Deploy", enabled: true, kind: "deploy" },
    ] },
  { id: "backend-pkg",    label: "后端应用包发布",   maven: false, builder: null,
    desc: "上传后端编译包 → 镜像构建 → 部署",
    stages: [
      { name: "Package", enabled: true, kind: "backend" },
      { name: "Image",   enabled: true, kind: "docker-build" },
      { name: "Deploy",  enabled: true, kind: "deploy" },
    ] },
  { id: "frontend-pkg",   label: "前端应用包发布",   maven: false, builder: null,
    desc: "上传前端静态包 → 镜像构建 → 部署",
    stages: [
      { name: "Package", enabled: true, kind: "frontend" },
      { name: "Image",   enabled: true, kind: "docker-build" },
      { name: "Deploy",  enabled: true, kind: "deploy" },
    ] },
];

// 后端代码编译构建模板创建时预置的 Maven settings.xml（含私有仓库镜像与凭证占位，用户可在「Maven 构建配置」中修改）
const DEFAULT_MAVEN_SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <servers>
    <server>
      <id>private-repo</id>
      <username>__USERNAME__</username>
      <password>__PASSWORD__</password>
    </server>
  </servers>
  <mirrors>
    <mirror>
      <id>nexus</id>
      <mirrorOf>external:*</mirrorOf>
      <url>https://nexus.example.com/repository/maven-public/</url>
    </mirror>
  </mirrors>
</settings>`;

// ---------- 创建/编辑子页（整页式，无 Modal） ----------
function PipelineEditorPage({
  onNav, onCreated,
}: { onNav: (n: PipelineNav) => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "", repo: "", branch: "main", trigger: "push", env: "测试环境", cluster: "", builderType: "maven",
  });
  const [stages, setStages] = useState<PipelineStageDef[]>([
    { name: "Clone", enabled: true }, { name: "Build", enabled: true },
    { name: "Test", enabled: true }, { name: "Image", enabled: true },
    { name: "Deploy", enabled: true },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  // 模板选择：选中后直接使用内置阶段结构（无需请求后端）
  const [selectedTmpl, setSelectedTmpl] = useState<string | null>(null);
  const [tmplStages, setTmplStages] = useState<PipelineStageDef[] | null>(null);
  const [tmplErr, setTmplErr] = useState("");

  const pickTemplate = (id: string | null) => {
    if (!id) {
      setSelectedTmpl(null); setTmplStages(null); setTmplErr("");
      setForm((f) => ({ ...f, builderType: "maven" })); // 自定义：默认 Maven，用户可改
      return;
    }
    const t = PIPELINE_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setSelectedTmpl(id); setTmplErr("");
    // 构建模版（maven/npm）默认值：代码编译构建类选模板即定，发布类不适用置空
    setForm((f) => ({ ...f, builderType: t.builder ?? "" }));
    // 直接使用内置阶段定义，无需请求后端
    const cloned: PipelineStageDef[] = t.stages.map((s) => ({
      name: s.name,
      enabled: s.enabled !== false,
      kind: s.kind,
      desc: s.desc,
      parallelOf: s.parallelOf,
      config: s.config ?? "",
    }));
    if (cloned.length === 0) {
      setTmplErr("模板阶段为空");
      setTmplStages(null);
    } else {
      setTmplStages(cloned);
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.name.trim()) { setErr("流水线名称不能为空"); return; }
    if (stages.length === 0 || stages.some((s) => !s.name.trim())) {
      setErr("至少需要一个非空阶段"); return;
    }
    setSubmitting(true); setErr("");
    try {
      if (selectedTmpl) {
        const t = PIPELINE_TEMPLATES.find((x) => x.id === selectedTmpl);
        if (!t) { setErr("模板无效"); setSubmitting(false); return; }
        if (!tmplStages || tmplStages.length === 0) {
          setErr("模板阶段为空，无法创建（请重新选择模板）"); setSubmitting(false); return;
        }
        await createPipeline({
          name: form.name.trim(),
          repo: form.repo.trim(),
          branch: form.branch.trim(),
          trigger: form.trigger,
          env: form.env,
          cluster: form.cluster.trim(),
          builderType: form.builderType,
          stages: tmplStages,
          mavenSettings: t.maven ? DEFAULT_MAVEN_SETTINGS_XML : "",
        });
      } else {
        if (stages.length === 0 || stages.some((s) => !s.name.trim())) {
          setErr("至少需要一个非空阶段"); setSubmitting(false); return;
        }
        await createPipeline({
          name: form.name.trim(),
          repo: form.repo.trim(),
          branch: form.branch.trim(),
          trigger: form.trigger,
          env: form.env,
          cluster: form.cluster.trim(),
          builderType: form.builderType,
          stages: stages.map((s) => ({ name: s.name.trim(), enabled: s.enabled })),
        });
      }
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setSubmitting(false); }
  };

  return (
    <div className="top-aura relative p-5 space-y-4">
      {/* 头部 + 返回 */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => onNav({ kind: "list" })}
          className="h-9 w-9 grid place-items-center rounded-lg border border-line bg-surface text-ink-600 hover:border-brand-300 hover:text-brand-700 transition"
          aria-label="返回流水线列表"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink-900 leading-none">创建流水线</h3>
          <p className="text-[11.5px] text-ink-400 mt-1">参考 Jenkins：Pipeline = Job，Stage = 阶段</p>
        </div>
      </div>

      {/* 模板选择：内置阶段结构，无需后端请求 */}
      <div className="rounded-xl border border-line bg-surface shadow-sh-2 card-beam overflow-hidden">
        <div className="p-4 border-b border-line flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
          <Layers size={14} className="text-brand-600" /> 选择流水线模板
          <span className="text-[11px] font-normal text-ink-400 ml-1">预置阶段结构，创建后可在画布自由编辑</span>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {PIPELINE_TEMPLATES.map((t) => {
            const active = selectedTmpl === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => pickTemplate(t.id)}
                className={`text-left rounded-lg border px-3 py-2.5 transition flex flex-col gap-1 ${active ? "border-brand-400 bg-brand-50 ring-1 ring-brand-200" : "border-line bg-subtle hover:border-brand-300 hover:bg-brand-50/40"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-ink-900">{t.label}</span>
                  {t.maven && (
                    <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Maven</span>
                  )}
                </div>
                <span className="text-[11px] text-ink-500 leading-snug">{t.desc}</span>
                <span className="text-[10px] text-ink-400 font-mono mt-0.5">{t.stages.length} 阶段</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => pickTemplate(null)}
            className={`text-left rounded-lg border px-3 py-2.5 transition flex flex-col gap-1 ${!selectedTmpl ? "border-brand-400 bg-brand-50 ring-1 ring-brand-200" : "border-dashed border-line bg-subtle hover:border-brand-300"}`}
          >
            <span className="text-[12.5px] font-semibold text-ink-900">自定义（不使用模板）</span>
            <span className="text-[11px] text-ink-500 leading-snug">手动配置阶段，从空白 5 阶段开始</span>
          </button>
        </div>
        {tmplErr && <div className="px-4 pb-3 text-[11px] text-err">{tmplErr}</div>}
        {selectedTmpl && tmplStages && (
          <div className="px-4 pb-4">
            <div className="text-[11px] text-ink-500 mb-1.5">将克隆以下阶段（含类型 / 配置）：</div>
            <div className="flex flex-wrap gap-1.5">
              {tmplStages.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-subtle border border-line px-2 py-1 text-[11px] text-ink-700">
                  <span className="font-mono text-[10px] text-ink-400">{i + 1}</span>
                  {s.name}
                  {s.kind && <span className="text-[9.5px] px-1 rounded bg-brand-100 text-brand-700">{s.kind}</span>}
                </span>
              ))}
            </div>
            <div className="mt-2 text-[11px]">
              {PIPELINE_TEMPLATES.find((t) => t.id === selectedTmpl)?.maven ? (
                <span className="text-amber-700">✓ 包含 Maven 构建配置（settings.xml），构建时挂到 /root/.m2/settings.xml</span>
              ) : (
                <span className="text-ink-400">此模板不含 Maven 构建配置（settings.xml）</span>
              )}
              <span className="text-ink-400"> · 阶段结构来自模板，创建后可在画布编辑</span>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface shadow-sh-2 card-beam overflow-hidden">
        <div className="p-5 space-y-4 border-b border-line">
          {err && <div className="rounded-md border border-err/30 bg-err-bg text-err text-[12px] px-3 py-2">{err}</div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="流水线名称 *">
              <TextInput value={form.name} onChange={set("name")} placeholder="my-service-ci" />
            </Field>
            <Field label="部署环境">
              <SelectInput value={form.env} onChange={set("env")}>
                <option>生产环境</option><option>预发环境</option><option>测试环境</option>
              </SelectInput>
            </Field>
            <Field label="构建集群（CI 真执行的临时 Pod 跑在哪个集群）">
              <ClusterSelect value={form.cluster} onChange={(v) => setForm((f) => ({ ...f, cluster: v }))} />
            </Field>
            {(!selectedTmpl || selectedTmpl === "backend-build" || selectedTmpl === "frontend-build") && (
              <Field label="构建模版（决定依赖缓存方式）">
                <SelectInput value={form.builderType} onChange={set("builderType")}>
                  <option value="maven">Maven（后端 Java · 缓存 ~/.m2）</option>
                  <option value="npm">npm（前端 Node · 缓存 cacache）</option>
                </SelectInput>
              </Field>
            )}
          </div>
        </div>

        {!selectedTmpl && (<div className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
              <ListTree size={14} className="text-brand-600" /> 阶段（按顺序执行）
            </div>
            <button
              onClick={() => setStages((s) => [...s, { name: "", enabled: true }])}
              className="h-8 px-3 rounded-md border border-line bg-surface text-[12px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1"
            >
              <Plus size={12} /> 添加阶段
            </button>
          </div>
          <div className="space-y-1.5">
            {stages.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md bg-subtle border border-line px-2 py-1.5">
                <span className="font-mono text-[10.5px] text-ink-400 w-6 text-center">{i + 1}</span>
                <input
                  value={s.name}
                  onChange={(e) => setStages((arr) => arr.map((x, j) => (j === i ? { name: e.target.value, enabled: x.enabled } : x)))}
                  placeholder="例如：Build / 单元测试 / 镜像构建 / 部署"
                  className="flex-1 h-8 px-2 text-[12.5px] rounded-md border border-line bg-surface outline-none focus:border-brand-300"
                />
                <button
                  onClick={() => setStages((arr) => arr.filter((_, j) => j !== i))}
                  className="h-8 w-8 grid place-items-center rounded-md text-ink-400 hover:text-err hover:bg-err-bg transition"
                  title="删除阶段"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-ink-400">
            提示：阶段名称决定控制台输出识别（Clone / 拉取 / Build / 编译 / Test / 测试 / Image / 镜像 / Deploy / 部署 / 发布 等关键字自动匹配合成步骤）。
          </p>
        </div>)}

        <div className="px-5 py-3 border-t border-line bg-subtle flex items-center justify-end gap-2">
          <button
            onClick={() => onNav({ kind: "list" })}
            disabled={submitting}
            className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50 flex items-center gap-1"
          >
            <Plus size={13} /> {submitting ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 详情子页（整页式：编排 / 构建历史 / 运行） ----------
function PipelineDetailPage({
  name, tab: tabProp, onNav,
}: { name: string; tab?: string; onNav: (n: PipelineNav) => void }) {
  const [detail, setDetail] = useState<PipelineDetailResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildRow | null>(null);
  const [running, setRunning] = useState(false);
  const [abortMsg, setAbortMsg] = useState<string>("");
  // 父级 → 构建历史 Tab 的刷新信号（刚运行/中止后递增，让列表立即反映新记录）
  const [buildsNonce, setBuildsNonce] = useState(0);
  const initialTab = (tabProp && (["canvas", "builds", "run"] as const).includes(tabProp as any))
    ? (tabProp as PipelineDetailTab)
    : "canvas";
  const [tab, setTabState] = useState<PipelineDetailTab>(initialTab);
  const setTab = (t: PipelineDetailTab) => {
    setTabState(t);
    onNav({ kind: "detail", name, tab: t });
  };
  useEffect(() => {
    if (tabProp && tabProp !== tab) setTabState(initialTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabProp, name]);
  const logRef = useRef<HTMLDivElement | null>(null);

  const reloadAll = async () => {
    try {
      const d = await getPipelineDetail(name);
      setDetail(d);
      if (!selected && d.builds.length > 0) setSelected(d.builds[0].id);
      const hasRunning = d.builds.some((b) => b.status === "running");
      setRunning(hasRunning);
    } catch (e) { setAbortMsg("加载失败：" + (e as Error).message); }
  };

  useEffect(() => {
    setSelected(null);
    setBuild(null);
    reloadAll();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [name]);

  useEffect(() => {
    if (!selected) { setBuild(null); return; }
    let alive = true;
    const fetchOne = () => getBuild(selected).then((b) => {
      if (!alive) return;
      setBuild(b);
      // 注意：running 状态由「流水线是否有 running build」（reloadAll 的 hasRunning）驱动，
      // 不依赖当前选中 build 的状态，避免选中历史记录时把中止按钮误置灰。
    }).catch(() => alive && setBuild(null));
    fetchOne();
    const t = setInterval(() => {
      getBuild(selected).then((b) => {
        if (!alive) return;
        setBuild(b);
        // 选中 build 状态变化时刷新详情，使 running / 中止目标（runningBuild）保持最新
        if (b.status !== "running") reloadAll();
      }).catch(() => {});
    }, 1500);
    return () => { alive = false; clearInterval(t); };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [selected]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [build?.stages]);

  const doRun = async () => {
    try {
      const r = await runPipeline(name);
      setSelected(r.buildNo);
      setRunning(true);
      setTab("run");
      setBuildsNonce((n) => n + 1);
      await reloadAll();
      reloadAll();
    } catch (e) { setAbortMsg("运行失败：" + (e as Error).message); }
  };
  // 当前真正在跑的构建（中止永远针对它，而非用户选中的历史记录）
  const runningBuild = detail?.builds.find((b) => b.status === "running") ?? null;
  const doAbort = async () => {
    const target = runningBuild?.id ?? selected;
    if (!target) return;
    try {
      await abortBuild(target);
      setAbortMsg("已发送中止信号，正在回收构建 Pod …");
      // 立即刷新一次，避免等轮询间隔
      reloadAll();
      setTimeout(() => setAbortMsg(""), 4000);
    }
    catch (e) { setAbortMsg("中止失败：" + (e as Error).message); }
  };
  const doDelete = async () => {
    if (!confirm(`确定删除流水线「${name}」及其全部构建记录？`)) return;
    try {
      await deletePipeline(name);
      onNav({ kind: "list" });
    } catch (e) { setAbortMsg("删除失败：" + (e as Error).message); }
  };

  const p = detail?.pipeline;

  // 基本信息本地 state（编辑头部字段时用，保存时 PUT updatePipeline）
  const [basicDraft, setBasicDraft] = useState({
    repo: "", branch: "main", trigger: "push", env: "测试环境", cluster: "", runtime: "docker",
    builderType: "maven", mavenSettings: "",
  });
  const [basicDirty, setBasicDirty] = useState(false);
  const [basicSaving, setBasicSaving] = useState(false);
  const [basicMsg, setBasicMsg] = useState("");
  const [mavenOpen, setMavenOpen] = useState(false);
  useEffect(() => {
    if (p) {
      setBasicDraft({
        repo: p.repo || "", branch: p.branch || "main",
        trigger: p.trigger || "push", env: p.env || "测试环境",
        cluster: p.cluster || "",
        runtime: p.runtime || "docker",
        builderType: p.builderType || "maven",
        mavenSettings: p.mavenSettings || "",
      });
      setBasicDirty(false); setBasicMsg("");
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [p?.name, p?.repo, p?.branch, p?.trigger, p?.env, p?.cluster, p?.runtime, p?.mavenSettings]);

  const setBasic = <K extends keyof typeof basicDraft>(k: K, v: string) => {
    setBasicDraft((d) => ({ ...d, [k]: v }));
    setBasicDirty(true);
  };
  const saveBasic = async () => {
    if (!p) return;
    setBasicSaving(true); setBasicMsg("");
    try {
      await updatePipeline(p.name, {
        name: p.name,
        repo: basicDraft.repo.trim(),
        branch: basicDraft.branch.trim(),
        trigger: basicDraft.trigger,
        env: basicDraft.env,
        cluster: basicDraft.cluster.trim(),
        runtime: basicDraft.runtime,
        builderType: basicDraft.builderType,
        mavenSettings: basicDraft.mavenSettings,
        stages: p.stages as any,
      });
      setBasicDirty(false);
      reloadAll();
    } catch (e) { setBasicMsg((e as Error).message); }
    finally { setBasicSaving(false); }
  };
  const ENVS = ["开发环境", "测试环境", "预发环境", "生产环境"];

  return (
    <div className="top-aura relative p-5 space-y-4">
      {/* 头部 + 返回 + 基本信息编辑栏 */}
      <div className="flex items-start gap-3 flex-wrap">
        <button
          onClick={() => onNav({ kind: "list" })}
          className="h-9 w-9 grid place-items-center rounded-lg border border-line bg-surface text-ink-600 hover:border-brand-300 hover:text-brand-700 transition"
          title="返回流水线列表"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <GitBranch size={15} className="text-brand-600 shrink-0" />
            <h3 className="text-[15px] font-semibold text-ink-900 leading-none truncate">{name}</h3>
            {p && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-md border border-line bg-subtle px-1.5 py-0.5 text-[10.5px] text-ink-600">
                <span className="font-mono">{triggerLabel(p.triggerMode)}</span>
                {p.defaultImage && <span className="font-mono text-ink-400">· {p.defaultImage}</span>}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-ink-400 mt-1 truncate">
            {p ? `${p.repo ? `${p.repo} · ` : ""}${p.branch || "—"} · 环境：${p.env || "—"}` : "加载中…"}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={doRun}
            disabled={running}
            className="h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium flex items-center gap-1 shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50"
          >
            <Play size={13} /> {running ? "运行中…" : "运行"}
          </button>
          <button
            onClick={doAbort}
            disabled={!running}
            className="h-9 px-3 rounded-lg border border-[#F5CFCC] bg-surface text-[12.5px] text-err flex items-center gap-1 hover:bg-err-bg transition disabled:opacity-40"
          >
            <Square size={12} /> 中止
          </button>
          <button
            onClick={doDelete}
            className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:border-err/40 hover:text-err transition flex items-center gap-1"
          >
            <Trash2 size={12} /> 删除
          </button>
        </div>
      </div>
      {abortMsg && (
        <div className="px-4 py-1.5 text-[11.5px] border-t border-line bg-surface">
          {abortMsg.startsWith("中止失败") ? (
            <span className="text-err">{abortMsg}</span>
          ) : (
            <span className="text-brand-600">{abortMsg}</span>
          )}
        </div>
      )}

      {/* 基本信息编辑栏（环境 / 仓库 / 分支 / 触发方式 / 部署环境） */}
      <div className="rounded-xl border border-line bg-subtle">
        <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface rounded-t-xl">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-800">
            <Pencil size={12} className="text-brand-600" /> 流水线基本信息
          </div>
          <button
            onClick={saveBasic}
            disabled={!basicDirty || basicSaving}
            className="h-7 px-3 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[11.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50 flex items-center gap-1"
          >
            <Check size={11} /> {basicSaving ? "保存中…" : "保存基本信息"}
          </button>
        </div>
        <div className="p-3 grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <Field label="部署环境">
            <SelectInput value={basicDraft.env} onChange={(e) => setBasic("env", e.target.value)}>
              {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
            </SelectInput>
          </Field>
          <Field label="构建集群（CI 临时 Pod 跑在哪个集群）">
            <ClusterSelect value={basicDraft.cluster} onChange={(v) => setBasic("cluster", v)} />
          </Field>
          <Field label="容器运行时">
            <SelectInput value={basicDraft.runtime} onChange={(e) => setBasic("runtime", e.target.value)} title="选 podman 时引擎会自动检测包管理器并安装，无需预装 baseImage">
              <option value="docker">docker（需 daemon）</option>
              <option value="podman">podman（daemonless，K8s Pod 内推荐）</option>
            </SelectInput>
          </Field>
          <Field label="构建模版（依赖缓存方式）">
            <SelectInput value={basicDraft.builderType} onChange={(e) => setBasic("builderType", e.target.value)}>
              <option value="maven">Maven（后端 · ~/.m2 缓存）</option>
              <option value="npm">npm（前端 · cacache 缓存）</option>
            </SelectInput>
          </Field>
          <Field label="状态">
            <input
              value={p ? `${p.lastStatus} · ${p.duration} · ${p.lastRun}` : "—"}
              readOnly
              className="h-9 px-2.5 text-[12px] rounded-md border border-line bg-sunken text-ink-500 font-mono"
            />
          </Field>
        </div>
        {/* 流水级 Maven 配置：改为按钮 + 弹窗编辑，节省基本信息栏空间 */}
        <div className="px-3 py-2.5 border-t border-line bg-subtle flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-ink-800 flex items-center gap-1.5">
              <Hammer size={12} className="text-brand-600" /> Maven 构建配置（settings.xml）
            </div>
            <p className="mt-0.5 text-[10.5px] text-ink-400 truncate">
              {basicDraft.mavenSettings
                ? `已配置 ${basicDraft.mavenSettings.length} 字符 · 构建时挂到 /root/.m2/settings.xml`
                : "未配置 · 点击右侧按钮编辑（含 servers/凭证，AES 加密落库）"}
            </p>
          </div>
          <Dialog open={mavenOpen} onOpenChange={setMavenOpen}>
            <button
              onClick={() => setMavenOpen(true)}
              className="h-8 px-3 rounded-md border border-line bg-surface text-[12px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1.5 shrink-0"
            >
              <Hammer size={12} /> {basicDraft.mavenSettings ? "编辑" : "配置"}
            </button>
            <DialogContent className="bg-surface text-ink-900 sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Hammer size={15} className="text-brand-600" /> Maven 构建配置（settings.xml）
                </DialogTitle>
                <DialogDescription className="text-ink-500">
                  仅本流水线生效；含 servers/凭证，已 AES 加密落库。公共 mirror / proxy 请交给平台级「构建配置」。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink-500">settings.xml 全文（构建时挂到 /root/.m2/settings.xml）</span>
                  <label className="h-7 px-2.5 rounded-md border border-line bg-surface text-[11px] text-ink-700 cursor-pointer hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1">
                    <UploadCloud size={12} /> 上传 settings.xml
                    <input
                      type="file"
                      accept=".xml,text/xml,application/xml"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const reader = new FileReader();
                        reader.onload = () => setBasic("mavenSettings", String(reader.result || ""));
                        reader.readAsText(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <LineNumberedTextArea
                  value={basicDraft.mavenSettings}
                  onChange={(e) => setBasic("mavenSettings", e.target.value)}
                  placeholder={'<settings>\n  <servers>\n    <server>\n      <id>private-repo</id>\n      <username>***</username>\n      <password>***</password>\n    </server>\n  </servers>\n</settings>'}
                  rows={14}
                  className="bg-surface"
                />
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <button className="h-9 px-4 rounded-md border border-line bg-surface text-[12.5px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition">
                    取消
                  </button>
                </DialogClose>
                <button
                  onClick={() => setMavenOpen(false)}
                  className="h-9 px-4 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition flex items-center gap-1"
                >
                  <Check size={13} /> 完成
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        {basicMsg && <div className="px-4 py-1.5 text-[11.5px] text-err border-t border-line bg-surface rounded-b-xl">{basicMsg}</div>}
      </div>

      {/* Tab 切换 */}
      <div className="rounded-xl border border-line bg-surface shadow-sh-2 card-beam overflow-hidden">
        <div className="flex items-center gap-0 px-3 pt-1.5 border-b border-line bg-surface overflow-x-auto">
          {([
            { id: "canvas", label: "编排", icon: Workflow },
            { id: "builds", label: "构建历史", icon: Clock },
            { id: "run", label: "运行", icon: Play },
          ] as const).map((t) => {
            const Active = tab === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 h-10 -mb-px border-b-2 text-[12.5px] transition shrink-0",
                  Active
                    ? "border-brand-500 text-brand-700 font-semibold"
                    : "border-transparent text-ink-500 hover:text-ink-900",
                )}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* 内容 */}
        <div className="p-5 min-h-[60vh]">
          {tab === "canvas" && (
            <CanvasTab
              p={p}
              onSaved={() => { reloadAll(); }}
            />
          )}
          {tab === "builds" && (
            <BuildsTab
              name={name}
              selected={selected}
              onOpen={(id) => { setSelected(id); setTab("run"); }}
              refreshTick={buildsNonce}
            />
          )}
          {tab === "run" && (
            <RunTab
              p={p}
              build={build}
              logRef={logRef}
              running={running}
              onAbort={doAbort}
              onRun={doRun}
            />
          )}
        </div>
      </div>
    </div>
  );
}

type PipelineDetailTab = "canvas" | "builds" | "run";

// 触发模式的中文标签
function triggerLabel(mode?: string): string {
  switch (mode) {
    case "git": return "Git 仓库";
    case "backend": return "后端编译包";
    case "frontend": return "前端静态包";
    case "image": return "镜像发布";
    default: return "Git 仓库";
  }
}

// ---------- 构建历史 Tab（分页 + 保留条数配置 + 点击看日志） ----------
function BuildsTab({
  name, selected, onOpen, refreshTick,
}: {
  name: string;
  selected: string | null;
  onOpen: (id: string) => void; // 点条目 → 切到「运行」Tab 展示该构建日志
  refreshTick: number;          // 父级触发刷新（如刚运行完）
}) {
  const [rows, setRows] = useState<BuildRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // 保留条数配置弹窗
  const [retOpen, setRetOpen] = useState(false);
  const [retKeep, setRetKeep] = useState<number>(10);
  const [retInput, setRetInput] = useState("10");
  const [retSaving, setRetSaving] = useState(false);

  const load = () => {
    setLoading(true);
    listBuilds({ pipeline: name, page, pageSize })
      .then((resp) => { setRows(resp.list ?? []); setTotal(resp.total); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [name, page, refreshTick]);

  const openRet = () => {
    getBuildRetention().then((r) => {
      setRetKeep(r.keep); setRetInput(String(r.keep));
    }).catch(() => { setRetKeep(10); setRetInput("10"); });
    setRetOpen(true);
  };
  const saveRet = async () => {
    const v = Math.max(1, Math.min(200, parseInt(retInput || "10", 10) || 10));
    setRetSaving(true);
    try {
      await saveBuildRetention(v);
      setRetKeep(v);
      setRetOpen(false);
      load(); // 保留条数可能变小 → 立即刷新（旧记录已被清理）
    } catch (e) {
      alert("保存失败：" + (e as Error).message);
    } finally { setRetSaving(false); }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 头部：标题 + 保留条数设置入口 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line shrink-0">
        <span className="text-[12px] font-semibold text-ink-900">构建历史</span>
        <span className="text-[11px] text-ink-400">共 {total} 条</span>
        <button
          onClick={openRet}
          className="ml-auto text-[11px] px-2.5 py-1 rounded-md border border-line bg-surface text-ink-600 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1"
        >
          <Clock size={12} /> 保留 {retKeep} 条 · 修改
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-1.5">
        {loading && rows.length === 0 ? (
          <div className="h-full grid place-items-center text-ink-400 text-[12px]">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="h-full grid place-items-center text-ink-400 text-[12px]">
            暂无构建 · 在「编排」Tab 配置完成后点「运行」
          </div>
        ) : (
          rows.map((b) => (
            <button
              key={b.id}
              onClick={() => onOpen(b.id)}
              title="点击查看该次构建日志"
              className={cn(
                "w-full text-left rounded-lg border px-3 py-2 transition flex items-center gap-2.5",
                selected === b.id ? "border-brand-300 bg-brand-50/40" : "border-line bg-surface hover:border-brand-200",
              )}
            >
              <span className="font-mono text-[12px] text-ink-900">{b.id}</span>
              <StatusBadge kind={toStatusKind(b.status)} label={b.status === "ok" ? "OK" : b.status === "running" ? "RUN" : b.status === "err" ? "FAIL" : "ABRT"} />
              <span className="text-[11.5px] text-ink-500">{b.trigger}</span>
              <span className="text-[11.5px] text-ink-500">·</span>
              <span className="font-mono text-[10.5px] text-ink-400 truncate">{b.branch}</span>
              <span className="ml-auto font-mono text-[10.5px] text-ink-400 shrink-0">{b.time} · {b.duration}</span>
            </button>
          ))
        )}
      </div>

      {/* 底部分页 */}
      {total > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-line shrink-0 text-[11px] text-ink-500">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-2 py-1 rounded-md border border-line bg-surface hover:border-brand-200 disabled:opacity-40 transition flex items-center gap-1"
          >
            <ChevronLeft size={12} /> 上一页
          </button>
          <span className="font-mono">第 {page} / {totalPages} 页</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-2 py-1 rounded-md border border-line bg-surface hover:border-brand-200 disabled:opacity-40 transition flex items-center gap-1"
          >
            下一页 <ChevronRight size={12} />
          </button>
          <span className="ml-auto">每页 {pageSize} 条</span>
        </div>
      )}

      {/* 保留条数设置弹窗 */}
      <Dialog open={retOpen} onOpenChange={setRetOpen}>
        <DialogContent className="bg-surface text-ink-900 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>构建记录保留条数</DialogTitle>
            <DialogDescription>
              每条流水线仅保留最近 N 条构建（含各阶段日志），超出部分在构建完成后自动清理。降低条数会立即删除旧记录。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Field label="保留条数（1–200）">
              <TextInput
                type="number"
                min={1}
                max={200}
                value={retInput}
                onChange={(e) => setRetInput(e.target.value)}
              />
            </Field>
            <p className="mt-2 text-[11px] text-ink-400">当前配置：{retKeep} 条（默认 10）</p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <button className="h-8 px-3 rounded-md border border-line bg-surface text-[12px] text-ink-600 hover:border-brand-300 transition">取消</button>
            </DialogClose>
            <button
              onClick={saveRet}
              disabled={retSaving}
              className="h-8 px-3 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50 flex items-center gap-1"
            >
              {retSaving && <Loader2 size={12} className="animate-spin" />} 保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- 运行 Tab：日志实时面板 ----------
function RunTab({
  p, build, logRef, running, onAbort, onRun,
}: {
  p: PipelineRow | undefined;
  build: BuildRow | null;
  logRef: React.RefObject<HTMLDivElement | null>;
  running: boolean;
  onAbort: () => void;
  onRun: () => void;
}) {
  if (!p) return <div className="h-full grid place-items-center text-ink-400 text-[12px]">加载中…</div>;
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-3 flex-wrap">
        <span className="text-[11.5px] text-ink-500">
          当前构建：<span className="font-mono text-ink-900">{build?.id ?? "—"}</span>
        </span>
        <span className="text-[11.5px] text-ink-500">
          触发源：<span className="font-mono text-ink-900">{triggerLabel(p.triggerMode)}</span>
        </span>
        {build?.branch && (
          <span className="text-[11.5px] text-ink-500">
            分支：<span className="font-mono text-ink-900">{build.branch}</span>
          </span>
        )}
        {build?.duration && (
          <span className="text-[11.5px] text-ink-500">
            耗时：<span className="font-mono text-ink-900">{build.duration}</span>
          </span>
        )}
        <span className="text-[11.5px] text-ink-500">
          状态：<span className="font-mono text-ink-900">{build?.status ?? "—"}</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={onRun}
            disabled={running}
            className="h-8 px-3 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12px] font-medium flex items-center gap-1 shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50"
          >
            <Play size={12} /> {running ? "运行中…" : "运行"}
          </button>
          <button
            onClick={onAbort}
            disabled={!running}
            className="h-8 px-3 rounded-md border border-[#F5CFCC] bg-surface text-[12px] text-err flex items-center gap-1 hover:bg-err-bg transition disabled:opacity-40"
          >
            <Square size={12} /> 中止
          </button>
        </span>
      </div>
      {build ? (
        <LogPanel build={build} logRef={logRef} />
      ) : (
        <div className="flex-1 grid place-items-center text-ink-400 text-[12px]">
          暂无构建 · 点右上「运行」开始
        </div>
      )}
    </div>
  );
}

// ---------- 单次构建的 console 日志（按阶段折叠的手风琴） ----------
function LogPanel({ build, logRef }: { build: BuildRow; logRef: React.RefObject<HTMLDivElement | null> }) {
  const stages = build.stages ?? [];
  const [open, setOpen] = useState<Record<number, boolean>>({});

  // 切换构建时按「长日志默认收起、进行中/报错默认展开」初始化
  useEffect(() => {
    const m: Record<number, boolean> = {};
    stages.forEach((s, i) => {
      const long = (s.log || "").split("\n").length > 40;
      const active = s.status === "running" || s.status === "err";
      m[i] = active || !long;
    });
    setOpen(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build.id]);

  const allOpen = stages.length > 0 && stages.every((_, i) => open[i]);
  const toggleAll = () => {
    const v = !allOpen;
    setOpen(Object.fromEntries(stages.map((_, i) => [i, v])));
  };
  const toggleOne = (i: number) => setOpen((m) => ({ ...m, [i]: !m[i] }));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 border-b border-line bg-surface flex items-center gap-2 shrink-0">
        <span className="text-[12px] font-semibold text-ink-900">构建日志</span>
        <span className="text-[10.5px] text-ink-400">点击阶段可展开 / 收起</span>
        <button
          onClick={toggleAll}
          className="ml-auto text-[11px] px-2.5 py-1 rounded-md border border-line bg-surface text-ink-600 hover:border-brand-300 hover:text-brand-700 transition"
        >
          {allOpen ? "全部收起" : "全部展开"}
        </button>
      </div>
      <div ref={logRef} className="flex-1 overflow-auto p-3 space-y-2">
        {stages.length === 0 ? (
          <div className="h-full grid place-items-center text-ink-400 text-[12px]">该构建暂无阶段日志</div>
        ) : (
          stages.map((s, i) => (
            <StageLogCard key={i} stage={s} open={!!open[i]} onToggle={() => toggleOne(i)} />
          ))
        )}
      </div>
    </div>
  );
}

// 阶段卡片：标题栏始终可见（可点击折叠），展开后显示带行内滚动的日志
function StageLogCard({ stage, open, onToggle }: {
  stage: { name: string; status?: string; log?: string; startedAt?: string; finishedAt?: string };
  open: boolean;
  onToggle: () => void;
}) {
  const log = stage.log || "";
  const lines = log ? log.split("\n") : [];
  const status = stage.status || "pending";
  const lineCount = lines.length;

  return (
    <div className={cn("rounded-lg border bg-surface overflow-hidden", stageBorderCls(status))}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sunken transition"
      >
        <ChevronRight size={13} className={cn("text-ink-400 transition-transform shrink-0", open && "rotate-90")} />
        <StageDot status={status} />
        <span className="text-[12.5px] font-semibold text-ink-900 truncate">{stage.name}</span>
        <StatusBadge kind={toStatusKind(status)} label={stageText[status] || status} />
        <span className="ml-auto text-[10.5px] font-mono text-ink-400 shrink-0">
          {lineCount > 0 ? `${lineCount} 行` : "无日志"}
          {stage.startedAt ? ` · ${stage.startedAt}` : ""}
        </span>
      </button>
      {open && (
        <div className="border-t border-line/70 px-3 py-2.5">
          {lineCount === 0 ? (
            <p className="text-[11px] text-ink-400 italic">该阶段暂无输出</p>
          ) : (
            <div className="relative">
              <button
                onClick={() => navigator.clipboard?.writeText(log)}
                title="复制日志"
                className="absolute right-1.5 top-1.5 z-10 text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-slate-300 hover:text-white transition"
              >
                <Copy size={10} className="inline -mt-0.5 mr-0.5" />复制
              </button>
              <div className="max-h-[320px] overflow-auto rounded-md bg-[#0A1424] border border-white/5 p-2.5 font-mono text-[11px] leading-[1.55]">
                {lines.map((ln, li) => (
                  <LogLine key={li} text={ln} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 单行日志着色：命令($ )青色、错误红、成功绿，其余浅灰
function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\s+/, "");
  let cls = "text-slate-300";
  if (t.startsWith("$ ")) cls = "text-cyan-300";
  else if (/fatal:|^error:|Exception|Cannot connect|exit code|BUILD FAIL|\bFAIL\b/i.test(t)) cls = "text-red-400";
  else if (/BUILD SUCCESS|完成 ✓|Reactor Summary|Uploaded|Pushed/i.test(t)) cls = "text-emerald-300";
  return (
    <div className={cn("whitespace-pre-wrap break-all px-0.5", cls)}>
      {text.length === 0 ? " " : text}
    </div>
  );
}

// 阶段卡片左边框按状态着色
function stageBorderCls(s: string): string {
  if (s === "ok") return "border-l-2 border-l-ok";
  if (s === "err") return "border-l-2 border-l-err";
  if (s === "running") return "border-l-2 border-l-brand-500";
  if (s === "aborted") return "border-l-2 border-l-warn";
  return "border border-line";
}

// ---------- 编排 Tab（Pipeline Canvas） ----------
// 节点分类：
//   触发源节点（SOURCE_KINDS = git/image/backend/frontend）：在画布**前端并列**，
//   多个源同时启动，全部完成后汇聚到下游节点
//   普通节点（build/test/deploy/notify/wait/custom）：按顺序执行
const NODE_LIBRARY: { key: PipelineNodeKind; label: string; desc: string; color: string; icon: any; group: "source" | "normal" }[] = [
  { key: "git",      label: "Git 仓库",       desc: "克隆 Git 仓库（支持账号密码 / 凭证）", color: "sky",     icon: GitBranch,    group: "source" },
  { key: "image",    label: "已有镜像",       desc: "引用已发布的镜像作为制品",       color: "indigo",  icon: Container,    group: "source" },
  { key: "backend",  label: "上传后端包",     desc: "上传 jar / war / zip / tar.gz 形式的二进制", color: "amber",   icon: PackageIcon,  group: "source" },
  { key: "frontend", label: "上传前端包",     desc: "上传 .zip 形式的前端构建产物",   color: "purple",  icon: BoxIcon,      group: "source" },
  { key: "build",    label: "编译构建",       desc: "选择基础构建镜像编译打包（前端 node / 后端 java）", color: "teal",    icon: ServerCog,    group: "normal" },
  { key: "docker-build", label: "镜像构建",   desc: "直接编写 Dockerfile 构建镜像（支持构建参数）", color: "orange", icon: Hammer, group: "normal" },
  { key: "push",     label: "推送镜像",       desc: "将镜像推送到镜像仓库（复用上游构建的镜像）", color: "violet",  icon: UploadCloud,  group: "normal" },
  { key: "test",     label: "测试 / Smoke",   desc: "运行测试或冒烟验证",              color: "cyan",    icon: Boxes,        group: "normal" },
  { key: "deploy",   label: "执行部署",       desc: "kubectl apply / rsync / 公网发布", color: "emerald", icon: ChevronRight, group: "normal" },
  { key: "configmap", label: "配置管理",      desc: "读取或编辑集群 ConfigMap（审计 / 批量改配置）", color: "fuchsia", icon: FileText,    group: "normal" },
  { key: "notify",   label: "告警通知",       desc: "通过 Webhook/邮件发送结果",        color: "rose",    icon: BellRing,     group: "normal" },
  { key: "wait",     label: "等待",           desc: "暂停 N 秒 / 审批门禁",             color: "slate",   icon: Hourglass,    group: "normal" },
  { key: "custom",   label: "自定义节点",     desc: "保留名称、只作为顺序占位",        color: "ink",     icon: Layers,       group: "normal" },
];
const SOURCE_KINDS: PipelineNodeKind[] = ["git", "image", "backend", "frontend"];

function colorClasses(color: string): { wrap: string; bg: string; ring: string; text: string; icon: string } {
  switch (color) {
    case "sky":     return { wrap: "bg-sky-50 border-sky-200",         bg: "bg-sky-500",     ring: "ring-sky-200",    text: "text-sky-700",    icon: "text-sky-500" };
    case "indigo":  return { wrap: "bg-indigo-50 border-indigo-200",   bg: "bg-indigo-500",  ring: "ring-indigo-200", text: "text-indigo-700", icon: "text-indigo-500" };
    case "amber":   return { wrap: "bg-amber-50 border-amber-200",     bg: "bg-amber-500",   ring: "ring-amber-200",  text: "text-amber-700",  icon: "text-amber-500" };
    case "purple":  return { wrap: "bg-purple-50 border-purple-200",   bg: "bg-purple-500",  ring: "ring-purple-200", text: "text-purple-700", icon: "text-purple-500" };
    case "teal":    return { wrap: "bg-teal-50 border-teal-200",       bg: "bg-teal-500",    ring: "ring-teal-200",   text: "text-teal-700",   icon: "text-teal-500" };
    case "cyan":    return { wrap: "bg-cyan-50 border-cyan-200",       bg: "bg-cyan-500",    ring: "ring-cyan-200",   text: "text-cyan-700",   icon: "text-cyan-500" };
    case "emerald": return { wrap: "bg-emerald-50 border-emerald-200", bg: "bg-emerald-500", ring: "ring-emerald-200", text: "text-emerald-700", icon: "text-emerald-500" };
    case "rose":    return { wrap: "bg-rose-50 border-rose-200",       bg: "bg-rose-500",    ring: "ring-rose-200",   text: "text-rose-700",   icon: "text-rose-500" };
    case "slate":   return { wrap: "bg-slate-50 border-slate-200",     bg: "bg-slate-500",   ring: "ring-slate-200",  text: "text-slate-700",  icon: "text-slate-500" };
    case "violet":  return { wrap: "bg-violet-50 border-violet-200",   bg: "bg-violet-500",  ring: "ring-violet-200", text: "text-violet-700", icon: "text-violet-500" };
    case "orange":  return { wrap: "bg-orange-50 border-orange-200",   bg: "bg-orange-500",  ring: "ring-orange-200", text: "text-orange-700", icon: "text-orange-500" };
    case "fuchsia": return { wrap: "bg-fuchsia-50 border-fuchsia-200", bg: "bg-fuchsia-500", ring: "ring-fuchsia-200", text: "text-fuchsia-700", icon: "text-fuchsia-500" };
    default:        return { wrap: "bg-ink-50 border-line",            bg: "bg-ink-500",     ring: "ring-line",       text: "text-ink-800",    icon: "text-ink-500" };
  }
}

function nodeKindOf(s: PipelineStageDef): PipelineNodeKind {
  if (s.kind) return s.kind;
  const n = (s.name || "").toLowerCase();
  if (n.includes("clone") || n.includes("git") || n.includes("拉取")) return "git";
  if (n.includes("deploy") || n.includes("部署") || n.includes("发布")) return "deploy";
  if (n.includes("test") || n.includes("测试")) return "test";
  if (n.includes("image") || n.includes("镜像")) return "image";
  if (n.includes("notif") || n.includes("告警")) return "notify";
  if (n.includes("configmap") || n.includes("配置管理") || n.includes("配置")) return "configmap";
  if (n.includes("docker-build") || n.includes("镜像构建")) return "docker-build";
  if (n.includes("build") || n.includes("编译") || n.includes("构建")) return "build";
  if (n.includes("wait") || n.includes("等待")) return "wait";
  if (n.includes("backend") || n.includes("后端")) return "backend";
  if (n.includes("frontend") || n.includes("前端")) return "frontend";
  return "custom";
}

// ---------- 编排 Tab（Pipeline Canvas + YAML 双视图） ----------
// 画布按"管道流 × 节点组"组织：
//   · 多条管道并列启动（每条管道 = 1 个触发源 + 顺序的若干"节点组"）
//   · 每个节点组（NodeGroup）= 1 个主线 stage + 0~N 个并行 stage（fan-out）
//     并行 stage 视觉上缩进显示在主线下方，完成后自动汇合（fan-in）到下一个节点组
//   · "添加流水线源" = 新增并列管道；组间的 + 按钮 = 在主线位置插入新节点组；
//     主线节点右上 hover 的 "+ 并行" 按钮 = 给该节点加并行子任务
// 顶部工具条：环境 / 产品 / 画布↔YAML 切换 / 保存
type NodeGroup = { stages: PipelineStageDef[] };
type Flow = { source: PipelineStageDef | null; groups: NodeGroup[] };
type EditTarget =
  | { kind: "source"; flowIdx: number }
  | { kind: "main"; flowIdx: number; groupIdx: number }
  | { kind: "parallel"; flowIdx: number; groupIdx: number; parallelIdx: number }
  | null;
function CanvasTab({
  p, onSaved,
}: { p: PipelineRow | undefined; onSaved: () => void }) {
  const [flows, setFlows] = useState<Flow[]>([{ source: null, groups: [] }]);
  const [picker, setPicker] = useState<
    | { kind: "source"; flowIdx: number; anchor: DOMRect }
    | { kind: "main"; flowIdx: number; pos: number; anchor: DOMRect }
    | { kind: "parallel"; flowIdx: number; groupIdx: number; anchor: DOMRect }
    | null
  >(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; desc: string }>({ name: "", desc: "" });
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  // 初始 stages 缓存（加载时存，用于 dirty 检测）
  const initialStagesRef = useRef<string>("");
  const [savingCanvas, setSavingCanvas] = useState(false);
  const [msg, setMsg] = useState<string>("");
  // 视图模式：canvas（默认）/ yaml
  const [viewMode, setViewMode] = useState<"canvas" |"yaml">("canvas");
  const [yamlText, setYamlText] = useState<string>("");
  const [yamlLoading, setYamlLoading] = useState(false);
  const [yamlSaving, setYamlSaving] = useState(false);
  const [yamlDirty, setYamlDirty] = useState(false);

  useEffect(() => {
    if (!p) return;
    const stages = ((p.stages ?? []) as any[]).map((s) => ({
      name: s.name,
      enabled: s.enabled !== false,
      kind: (s.kind as PipelineNodeKind) || nodeKindOf(s as any),
      desc: s.desc || "",
      parallelOf: (s.parallelOf as string) || "",
      config: (s.config as string) || "",
    })) as PipelineStageDef[];
    // 把扁平 stages 拆成管道 × 节点组
    const fs: Flow[] = [];
    let cur: Flow | null = null;
    for (const s of stages) {
      if (SOURCE_KINDS.includes(s.kind as PipelineNodeKind)) {
        cur = { source: s, groups: [] };
        fs.push(cur);
        continue;
      }
      if (!cur) {
        cur = { source: null, groups: [] };
        fs.push(cur);
      }
      if (!s.parallelOf) {
        // 主线 stage，开新节点组
        cur.groups.push({ stages: [s] });
      } else {
        // 并行 stage，按 parallelOf 找父 group
        const parentGroup = cur.groups.find(
          (g) => g.stages[0] && g.stages[0].name === s.parallelOf,
        );
        if (parentGroup) {
          parentGroup.stages.push({ ...s, parallelOf: s.parallelOf });
        } else {
          // 找不到父（如父被改名为 parallelOf 找不到），降级为主线
          cur.groups.push({ stages: [{ ...s, parallelOf: "" }] });
        }
      }
    }
    if (fs.length === 0) fs.push({ source: null, groups: [] });
    setFlows(fs);
    // 缓存 initial stages JSON（保留原始顺序，用于 dirty 比对）
    initialStagesRef.current = JSON.stringify(stages.map((s) => ({
      name: s.name, enabled: s.enabled, kind: s.kind, desc: s.desc, parallelOf: s.parallelOf, config: s.config,
    })));
    setMsg("");
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [p?.name]);

  // 切到 YAML 模式时拉 YAML
  useEffect(() => {
    if (viewMode !== "yaml" || !p) return;
    setYamlLoading(true);
    fetch(`/api/pipelines/${encodeURIComponent(p.name)}/yaml${getCluster() ? `?cluster=${encodeURIComponent(getCluster())}` : ""}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("kubehelm.token") || ""}` },
    })
      .then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((t) => { setYamlText(t); setYamlDirty(false); })
      .catch((e) => setMsg(`YAML 加载失败：${(e as Error).message}`))
      .finally(() => setYamlLoading(false));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [viewMode, p?.name]);

  // flows ↔ 扁平 stages（保存时按 source → groups 顺序展平，并行 stage 标注 parallelOf）
  const flattenFlows = (fs: Flow[]): PipelineStageDef[] => {
    const out: PipelineStageDef[] = [];
    for (const f of fs) {
      if (f.source) out.push({ ...f.source, parallelOf: "" });
      for (const g of f.groups) {
        if (g.stages.length === 0) continue;
        const main = g.stages[0];
        out.push({ ...main, parallelOf: "" });
        for (let k = 1; k < g.stages.length; k++) {
          out.push({ ...g.stages[k], parallelOf: main.name });
        }
      }
    }
    return out;
  };
  // 在指定管道设置源节点（覆盖或新建）
  const setSource = (flowIdx: number, kind: PipelineNodeKind) => {
    const def = NODE_LIBRARY.find((n) => n.key === kind);
    if (!def) return;
    setFlows((arr) => arr.map((f, j) => j === flowIdx ? {
      ...f,
      source: { name: def.label, enabled: true, kind, desc: def.desc },
    } : f));
    setPicker(null);
  };
  // 在指定管道的"主线"位置插入新节点组（pos 是 group 索引）
  const insertMainAt = (flowIdx: number, pos: number, kind: PipelineNodeKind) => {
    const def = NODE_LIBRARY.find((n) => n.key === kind);
    if (!def) return;
    setFlows((arr) => arr.map((f, j) => {
      if (j !== flowIdx) return f;
      const groups = f.groups.slice();
      groups.splice(pos, 0, { stages: [{ name: def.label, enabled: true, kind, desc: def.desc, parallelOf: "" }] });
      return { ...f, groups };
    }));
    setPicker(null);
  };
  // 给指定 group 的主线加并行 stage（fan-out）
  const addParallel = (flowIdx: number, groupIdx: number, kind: PipelineNodeKind) => {
    const def = NODE_LIBRARY.find((n) => n.key === kind);
    if (!def) return;
    setFlows((arr) => arr.map((f, j) => {
      if (j !== flowIdx) return f;
      const groups = f.groups.map((g, k) => {
        if (k !== groupIdx) return g;
        if (g.stages.length === 0) return g;
        const main = g.stages[0];
        return { stages: [...g.stages, { name: def.label, enabled: true, kind, desc: def.desc, parallelOf: main.name }] };
      });
      return { ...f, groups };
    }));
    setPicker(null);
  };
  // 清除管道的源
  const clearSource = (flowIdx: number) => {
    setFlows((arr) => arr.map((f, j) => j === flowIdx ? { ...f, source: null } : f));
  };
  // 删除主线 stage（含其并行 sibling）
  const removeMain = (flowIdx: number, groupIdx: number) => {
    setFlows((arr) => arr.map((f, j) => j === flowIdx ? {
      ...f, groups: f.groups.filter((_, k) => k !== groupIdx),
    } : f));
  };
  // 删除单个并行 stage
  const removeParallel = (flowIdx: number, groupIdx: number, parallelIdx: number) => {
    setFlows((arr) => arr.map((f, j) => {
      if (j !== flowIdx) return f;
      const groups = f.groups.map((g, k) => {
        if (k !== groupIdx) return g;
        const stages = g.stages.filter((_, ki) => ki !== parallelIdx);
        return { stages };
      });
      return { ...f, groups };
    }));
  };
  // 新增一个并列管道（无源、待用户选）
  const addFlow = () => setFlows((arr) => [...arr, { source: null, groups: [] }]);
  // 删除整条管道
  const removeFlow = (flowIdx: number) =>
    setFlows((arr) => arr.filter((_, j) => j !== flowIdx));
  // 打开节点编辑（弹窗）
  const openEdit = (target: Exclude<EditTarget, null>) => {
    const f = flows[target.flowIdx];
    let node: PipelineStageDef | null = null;
    if (target.kind === "source") node = f.source;
    else if (target.kind === "main") node = f.groups[target.groupIdx]?.stages[0] || null;
    else if (target.kind === "parallel") node = f.groups[target.groupIdx]?.stages[target.parallelIdx] || null;
    if (!node) return;
    setEditing(target);
    setEditDraft({ name: node.name, desc: node.desc || "" });
    // 解析 config 字符串为 Record（容错：解析失败按空对象处理）
    let cfg: Record<string, string> = {};
    try {
      const parsed = node.config ? JSON.parse(node.config) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cfg = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]));
      }
    } catch {/* 容错 */}
    setEditConfig(cfg);
  };
  const saveEdit = () => {
    if (!editing) return;
    const name = editDraft.name.trim();
    if (!name) { setMsg("节点名称不能为空"); return; }
    const configStr = Object.keys(editConfig).length > 0 ? JSON.stringify(editConfig) : "";
    setFlows((arr) => arr.map((f, j) => {
      if (j !== editing.flowIdx) return f;
      if (editing.kind === "source") {
        return { ...f, source: f.source ? { ...f.source, name, desc: editDraft.desc.trim(), config: configStr } : f.source };
      }
      const groups = f.groups.map((g, k) => {
        if (editing.kind === "main" && k === editing.groupIdx) {
          const main = g.stages[0];
          const newMain = { ...main, name, desc: editDraft.desc.trim(), config: configStr };
          // 主线改名：其所有并行的 parallelOf 必须同步更新
          const stages = [newMain, ...g.stages.slice(1).map((p) => ({ ...p, parallelOf: newMain.name }))];
          return { stages };
        }
        if (editing.kind === "parallel" && k === editing.groupIdx) {
          const stages = g.stages.map((s, ki) => ki === editing.parallelIdx ? { ...s, name, desc: editDraft.desc.trim(), config: configStr } : s);
          return { stages };
        }
        return g;
      });
      return { ...f, groups };
    }));
    setEditing(null);
    setMsg("");
  };
  // 切换节点类型（编辑弹窗里改 kind）—— 同时清空 config
  const switchEditKind = (kind: PipelineNodeKind) => {
    if (!editing) return;
    const def = NODE_LIBRARY.find((n) => n.key === kind);
    if (!def) return;
    setFlows((arr) => arr.map((f, j) => {
      if (j !== editing.flowIdx) return f;
      if (editing.kind === "source") {
        const cur = f.source || { name: def.label, enabled: true, kind, desc: def.desc, parallelOf: "", config: "" };
        return { ...f, source: { ...cur, kind, desc: editDraft.desc || def.desc, config: "" } };
      }
      const groups = f.groups.map((g, k) => {
        if (editing.kind === "main" && k === editing.groupIdx) {
          const stages = g.stages.map((s, ki) => ki === 0 ? { ...s, kind, config: "" } : s);
          return { stages };
        }
        if (editing.kind === "parallel" && k === editing.groupIdx) {
          const stages = g.stages.map((s, ki) => ki === editing.parallelIdx ? { ...s, kind, config: "" } : s);
          return { stages };
        }
        return g;
      });
      return { ...f, groups };
    }));
    setEditDraft((d) => ({ name: d.name.trim() ? d.name : def.label, desc: d.desc || def.desc }));
    setEditConfig({});
  };
  const saveCanvas = async () => {
    if (!p) return;
    // 过滤掉完全空的管道（既无源也无 group）
    const cleaned = flows.filter((f) => f.source || f.groups.length > 0);
    const stages = flattenFlows(cleaned);
    if (stages.length === 0) { setMsg("画布至少需要一个节点（先添加流水线源）"); return; }
    if (stages.some((n) => !n.name.trim())) { setMsg("节点名称不能为空"); return; }
    setSavingCanvas(true); setMsg("");
    try {
      await updatePipelineStages(p.name, stages);
      setFlows(cleaned.length ? cleaned : [{ source: null, groups: [] }]);
      // 保存成功：刷新 initialStagesRef 以重置 dirty
      initialStagesRef.current = JSON.stringify(stages.map((s) => ({
        name: s.name, enabled: s.enabled, kind: s.kind, desc: s.desc, parallelOf: s.parallelOf, config: s.config,
      })));
      onSaved();
    } catch (e) { setMsg((e as Error).message); }
    finally { setSavingCanvas(false); }
  };
  const saveYaml = async () => {
    if (!p) return;
    setYamlSaving(true); setMsg("");
    try {
      const r = await fetch(`/api/pipelines/${encodeURIComponent(p.name)}/yaml`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("kubehelm.token") || ""}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: yamlText,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setYamlDirty(false);
      onSaved();
    } catch (e) { setMsg((e as Error).message); }
    finally { setYamlSaving(false); }
  };

  if (!p) return <div className="h-full grid place-items-center text-ink-400 text-[12px]">加载中…</div>;

  // 统计：触发源数 / 普通节点数
  const sourceCount = flows.filter((f) => f.source).length;
  const allStages: PipelineStageDef[] = [];
  for (const f of flows) {
    if (f.source) allStages.push(f.source);
    for (const g of f.groups) for (const s of g.stages) allStages.push(s);
  }
  const stepCount = allStages.length;
  const enabledCount = allStages.filter((x) => x.enabled !== false).length;
  const parallelCount = allStages.filter((s) => !!s.parallelOf).length;
  // 画布是否相对加载初始态有改动（用于保存按钮灰态）
  // 必须基于 flows 实时计算，不能依赖 ref：useEffect 里更新 ref 不会触发重渲染，
  // 会导致改名/改配置后 dirty 仍为 false、保存按钮误灰、无法保存画布。
  const liveStagesJson = JSON.stringify(
    flattenFlows(flows).map((s) => ({
      name: s.name, enabled: s.enabled, kind: s.kind, desc: s.desc, parallelOf: s.parallelOf, config: s.config,
    })),
  );
  const canvasDirty = liveStagesJson !== "" && liveStagesJson !== initialStagesRef.current;

  const renderNode = (n: PipelineStageDef, opts: {
    onEdit?: () => void;
    onDelete?: () => void;
    onAddParallel?: (anchor?: HTMLElement) => void;
    showHandle?: boolean;
    size?: "sm" | "md";
  } = {}) => {
    const lib = NODE_LIBRARY.find((x) => x.key === n.kind) || NODE_LIBRARY[NODE_LIBRARY.length - 1];
    const c = colorClasses(lib.color);
    const Icon = lib.icon;
    const isSm = opts.size === "sm";
    return (
      <div className="relative group/node flex flex-col items-center min-w-[140px]">
        <div
          onClick={() => opts.onEdit?.()}
          className={cn(
            "relative rounded-xl border bg-white flex items-center gap-2 shadow-sm transition cursor-pointer hover:border-brand-300 hover:shadow-sh-1",
            isSm ? "px-2.5 py-1.5 w-[140px]" : "px-3 py-2 w-[160px]",
            c.wrap,
            !n.enabled && "opacity-55",
          )}
        >
          {n.enabled ? (
            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", c.bg)} title="已启用" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full shrink-0 border border-line" title="已关闭" />
          )}
          <Icon size={isSm ? 11 : 13} className={cn("shrink-0", c.icon)} />
          <div className="min-w-0 flex-1">
            <div className={cn(isSm ? "text-[11.5px]" : "text-[12px]", "font-medium truncate", c.text)} title={n.name}>{n.name}</div>
            {n.desc && <div className={cn("text-ink-500 truncate", isSm ? "text-[9.5px]" : "text-[10px]")} title={n.desc}>{n.desc}</div>}
          </div>
          {(opts.onEdit || opts.onDelete || opts.onAddParallel) && (
            <div className="absolute -top-1.5 -right-1.5 flex items-center gap-0.5 opacity-0 group-hover/node:opacity-100 transition-opacity">
              {opts.onAddParallel && (
                <button
                  onClick={(e) => { e.stopPropagation(); opts.onAddParallel?.(e.currentTarget); }}
                  className="w-6 h-6 grid place-items-center rounded-full bg-white border border-line shadow-sm text-brand-600 hover:border-brand-300 transition"
                  title="添加并行任务"
                >
                  <Plus size={11} />
                </button>
              )}
              {opts.onEdit && (
                <button
                  onClick={(e) => { e.stopPropagation(); opts.onEdit?.(); }}
                  className="w-6 h-6 grid place-items-center rounded-full bg-white border border-line shadow-sm text-ink-500 hover:text-brand-600 hover:border-brand-300 transition"
                  title="编辑节点"
                >
                  <Pencil size={11} />
                </button>
              )}
              {opts.onDelete && (
                <button
                  onClick={(e) => { e.stopPropagation(); opts.onDelete?.(); }}
                  className="w-6 h-6 grid place-items-center rounded-full bg-white border border-line shadow-sm text-ink-500 hover:text-err hover:border-err/40 transition"
                  title="删除节点"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          )}
        </div>
        {opts.showHandle !== false && (
          <div className="font-mono text-[10px] text-ink-400 mt-0.5 bg-white px-1.5 rounded border border-line">
            {lib.label}
          </div>
        )}
      </div>
    );
  };

  const renderConnector = (onPlus: (anchor: DOMRect) => void, active: boolean) => (
    <div className="flex items-center select-none -mt-5">
      <span className="block w-10 h-px bg-line" />
      <button
        onClick={(e) => onPlus(e.currentTarget.getBoundingClientRect())}
        title="插入新节点"
        className={cn(
          "w-6 h-6 -my-1 rounded-full grid place-items-center border shadow-sm transition shrink-0",
          active
            ? "bg-brand-600 border-brand-600 text-white"
            : "bg-ink-900 border-ink-900 text-white hover:scale-110",
        )}
      >
        <Plus size={11} />
      </button>
      <span className="block w-10 h-px bg-line" />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* === 顶部工具条 === */}
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-line bg-subtle">
        <Workflow size={14} className="text-brand-600" />
        <div className="text-[12.5px] font-semibold text-ink-800">编排</div>
        <span className="text-[11px] text-ink-500 ml-2">环境</span>
        <span className="h-7 px-2.5 inline-flex items-center text-[12px] rounded-md border border-line bg-white font-mono">
          {p.env || "—"}
        </span>
        <span className="text-[11px] text-ink-500 ml-3">产品</span>
        <input
          value={p.env || ""}
          readOnly
          className="h-7 w-28 px-2 text-[12px] rounded-md border border-line bg-sunken text-ink-500"
        />
        <span className="text-[11px] text-ink-500 ml-2">YAML</span>
        <div className="inline-flex items-center rounded-md border border-line bg-white overflow-hidden">
          <button
            onClick={() => setViewMode("canvas")}
            className={cn(
              "h-7 px-2.5 text-[11.5px] flex items-center gap-1 transition",
              viewMode === "canvas" ? "bg-brand-50 text-brand-700 font-semibold" : "text-ink-500 hover:bg-sunken",
            )}
          >
            <Workflow size={11} /> 画布
          </button>
          <button
            onClick={() => setViewMode("yaml")}
            className={cn(
              "h-7 px-2.5 text-[11.5px] flex items-center gap-1 transition border-l border-line",
              viewMode === "yaml" ? "bg-brand-50 text-brand-700 font-semibold" : "text-ink-500 hover:bg-sunken",
            )}
          >
            YAML
          </button>
        </div>
        <span className="font-mono text-[10.5px] text-ink-400 ml-2">
          {stepCount} 节点 · {enabledCount} 启用 · {sourceCount} 个流水线源{parallelCount > 0 ? ` · ${parallelCount} 个并行任务` : ""}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={viewMode === "canvas" ? saveCanvas : saveYaml}
            disabled={viewMode === "canvas" ? (savingCanvas || !canvasDirty) : (yamlSaving || !yamlDirty)}
            title={viewMode === "canvas" && !canvasDirty ? "没有改动，无需保存" : undefined}
            className="h-8 px-3 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12px] font-medium flex items-center gap-1 shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={12} /> {viewMode === "canvas" ? (savingCanvas ? "保存中…" : "保存画布") : (yamlSaving ? "保存中…" : "保存 YAML")}
          </button>
        </div>
      </div>

      {msg && <div className="rounded-md border border-err/30 bg-err-bg text-err text-[12px] px-3 py-2">{msg}</div>}

      {/* === 画布模式 === */}
      {viewMode === "canvas" && (
        <div className="rounded-xl border border-line bg-surface">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-surface rounded-t-xl">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-800">
              <ListTree size={13} className="text-brand-600" /> 编排画布
              <span className="text-[11px] text-ink-400 font-normal ml-1">
                {sourceCount} 个流水线源（并列） · {stepCount} 个节点 · {parallelCount} 个并行任务
              </span>
            </div>
            <div className="text-[10.5px] text-ink-400">
              hover 节点 · 可改名称 / 类型 · 节点之间点 <Plus size={9} className="inline" /> 插入主线 · hover 主线右上加 <Plus size={9} className="inline" /> 挂并行任务
            </div>
          </div>

          <div className="bg-sunken/40 p-4 overflow-auto min-h-[280px] space-y-3">
            {flows.length === 0 && (
              <div className="text-center text-ink-400 text-[12px] py-10">
                暂无节点 · 点下方「+ 添加流水线源」开始编排
              </div>
            )}
            {flows.map((f, i) => (
              <FlowRow
                key={`flow-${i}`}
                flow={f}
                onPickSource={(anchor) => setPicker({ kind: "source", flowIdx: i, anchor })}
                onPickMain={(pos, anchor) => setPicker({ kind: "main", flowIdx: i, pos, anchor })}
                onPickParallel={(groupIdx, anchor) => setPicker({ kind: "parallel", flowIdx: i, groupIdx, anchor })}
                onEditSource={() => openEdit({ kind: "source", flowIdx: i })}
                onEditMain={(groupIdx) => openEdit({ kind: "main", flowIdx: i, groupIdx })}
                onEditParallel={(groupIdx, parallelIdx) => openEdit({ kind: "parallel", flowIdx: i, groupIdx, parallelIdx })}
                onRemoveSource={() => clearSource(i)}
                onRemoveMain={(groupIdx) => removeMain(i, groupIdx)}
                onRemoveParallel={(groupIdx, parallelIdx) => removeParallel(i, groupIdx, parallelIdx)}
                onRemoveFlow={() => removeFlow(i)}
                renderNode={renderNode}
                renderConnector={renderConnector}
              />
            ))}

            <div className="pt-2">
              <button
                onClick={addFlow}
                className="rounded-xl border border-dashed border-line bg-white px-3.5 h-10 flex items-center gap-1.5 text-[12px] text-ink-600 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50/40 transition"
              >
                <Plus size={13} className="text-brand-600" /> 添加流水线源
              </button>
              <span className="text-[11px] text-ink-400 ml-2">
                多个流水线源并列启动 · 各自包含后续步骤
              </span>
            </div>

            {picker && (
              <PickerPopover
                anchor={picker.anchor}
                filterGroup={picker.kind === "source" ? "source" : "normal"}
                title={
                  picker.kind === "source"
                    ? "选择流水线源（作为此管道起点）"
                    : picker.kind === "main"
                    ? "选择要插入的主线节点（顺序执行）"
                    : "选择要挂载的并行任务（与该主线同时执行，完成后汇合）"
                }
                onPick={(k) => {
                  if (picker.kind === "source") setSource(picker.flowIdx, k);
                  else if (picker.kind === "main") insertMainAt(picker.flowIdx, picker.pos, k);
                  else addParallel(picker.flowIdx, picker.groupIdx, k);
                }}
                onClose={() => setPicker(null)}
              />
            )}
          </div>
        </div>
      )}

      {/* === YAML 模式 === */}
      {viewMode === "yaml" && (
        <div className="rounded-xl border border-line bg-surface">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-surface rounded-t-xl">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-800">
              <Workflow size={12} className="text-brand-600" /> YAML 描述
              <span className="text-[11px] text-ink-400 font-normal ml-1">
                与画布内容对应 · 保存后画布自动 reload
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-ink-500">
              {yamlDirty && <span className="text-warn font-mono">· 有未保存的修改</span>}
              <button
                onClick={() => {
                  fetch(`/api/pipelines/${encodeURIComponent(p.name)}/yaml${getCluster() ? `?cluster=${encodeURIComponent(getCluster())}` : ""}`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem("kubehelm.token") || ""}` },
                  })
                    .then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
                    .then((t) => { setYamlText(t); setYamlDirty(false); })
                    .catch((e) => setMsg(`YAML 重新加载失败：${(e as Error).message}`));
                }}
                disabled={yamlLoading}
                className="h-7 px-2.5 rounded-md border border-line bg-surface text-[11px] hover:bg-sunken transition disabled:opacity-40"
              >
                {yamlLoading ? "加载中…" : "重新拉取"}
              </button>
            </div>
          </div>
          <div className="p-3">
            {yamlLoading ? (
              <div className="h-[420px] grid place-items-center text-ink-400 text-[12px]">YAML 加载中…</div>
            ) : (
              <textarea
                value={yamlText}
                onChange={(e) => { setYamlText(e.target.value); setYamlDirty(true); }}
                spellCheck={false}
                className="w-full h-[420px] px-3 py-2 font-mono text-[12px] text-ink-800 bg-sunken border border-line rounded-lg outline-none focus:border-brand-300 resize-y leading-relaxed"
                placeholder="# 输入 pipeline.yaml …"
              />
            )}
            <div className="mt-2 text-[10.5px] text-ink-400">
              提示：画布节点修改保存后再次切换到 YAML 即可看到最新描述。
            </div>
          </div>
        </div>
      )}

      {/* === 单节点编辑弹窗 === */}
      {editing && (() => {
        const f = flows[editing.flowIdx];
        let node: PipelineStageDef | null = null;
        if (editing.kind === "source") node = f?.source || null;
        else if (editing.kind === "main") node = f?.groups[editing.groupIdx]?.stages[0] || null;
        else if (editing.kind === "parallel") node = f?.groups[editing.groupIdx]?.stages[editing.parallelIdx] || null;
        if (!node) return null;
        const editKind = node.kind as PipelineNodeKind;
        const lib = NODE_LIBRARY.find((n) => n.key === editKind) || NODE_LIBRARY[NODE_LIBRARY.length - 1];
        return (
          <EditNodeModal
            key={`${editing.flowIdx}-${editing.kind}-${("groupIdx" in editing) ? editing.groupIdx : 0}-${("parallelIdx" in editing) ? editing.parallelIdx : 0}`}
            draft={editDraft}
            setDraft={setEditDraft}
            config={editConfig}
            setConfig={setEditConfig}
            nodeKind={editKind}
            onSwitchKind={switchEditKind}
            onClose={() => setEditing(null)}
            onSave={saveEdit}
            titleSuffix={
              editing.kind === "source" ? "源节点"
              : editing.kind === "main" ? "主线节点"
              : "并行任务"
            }
            libLabel={lib.label}
            pipelineName={p!.name}
            stageName={node.name}
            hasImageNode={flows.some((f) => f.source?.kind === "image" || f.source?.kind === "push" || f.source?.kind === "docker-build" || f.groups.some((g) => g.stages.some((s) => s.kind === "image" || s.kind === "push" || s.kind === "docker-build")))}
          />
        );
      })()}
    </div>
  );
}

// ---------- 单条管道渲染 ----------
// 视觉：源 ─●─ [节点组1] ─●─ [节点组2] ─●─ ...
// 每个"节点组"是垂直栈（main stage + 缩进的并行 sibling）
function FlowRow({
  flow,
  onPickSource,
  onPickMain,
  onPickParallel,
  onEditSource,
  onEditMain,
  onEditParallel,
  onRemoveSource,
  onRemoveMain,
  onRemoveParallel,
  onRemoveFlow,
  renderNode,
  renderConnector,
}: {
  flow: Flow;
  onPickSource: (anchor: DOMRect) => void;
  onPickMain: (pos: number, anchor: DOMRect) => void;
  onPickParallel: (groupIdx: number, anchor: DOMRect) => void;
  onEditSource: () => void;
  onEditMain: (groupIdx: number) => void;
  onEditParallel: (groupIdx: number, parallelIdx: number) => void;
  onRemoveSource: () => void;
  onRemoveMain: (groupIdx: number) => void;
  onRemoveParallel: (groupIdx: number, parallelIdx: number) => void;
  onRemoveFlow: () => void;
  renderNode: (n: PipelineStageDef, opts?: any) => React.ReactNode;
  renderConnector: (onPlus: (anchor: DOMRect) => void, active: boolean) => React.ReactNode;
}) {
  const rectOf = (el: HTMLElement | null | undefined): DOMRect =>
    el ? el.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
  const hasSource = !!flow.source;
  const groupCount = flow.groups.length;
  const parallelCount = flow.groups.reduce((s, g) => s + Math.max(0, g.stages.length - 1), 0);
  return (
    <div className="group/flow relative rounded-xl border border-line bg-white/70 hover:bg-white hover:border-brand-200 hover:shadow-sh-1 transition p-3 pl-4">
      {/* 左侧源标识带 */}
      <div className="absolute top-2 left-0 bottom-2 w-1 rounded-r-full bg-gradient-to-b from-brand-400 to-cyan-400" />
      <div className="flex items-start gap-3">
        {/* 主体：横向节点链 */}
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="flex items-center gap-2 min-h-[64px]">
            {!hasSource ? (
              <button
                onClick={(e) => onPickSource(rectOf(e.currentTarget))}
                className="rounded-xl border border-dashed border-line bg-white px-4 h-[56px] flex items-center gap-2 text-[12px] text-ink-500 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50/40 transition shrink-0"
              >
                <Plus size={14} className="text-brand-600" /> 选择流水线源
              </button>
            ) : (
              <>
                {renderNode(flow.source!, {
                  onEdit: onEditSource,
                  onDelete: onRemoveSource,
                  showHandle: false,
                })}
                {renderConnector((el) => onPickMain(0, el), false)}
              </>
            )}

            {/* 节点组 */}
            {flow.groups.map((g, k) => (
              <span key={`g-${k}`} className="flex items-center gap-2 shrink-0">
                {/* 节点组容器：main 在上 + parallel 缩进在下 */}
                <span className="relative flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-line/70 bg-sunken/40 px-3 py-3">
                  {/* main stage */}
                  {g.stages[0] && renderNode(g.stages[0], {
                    onEdit: () => onEditMain(k),
                    onDelete: () => onRemoveMain(k),
                    onAddParallel: (el?: HTMLElement) => onPickParallel(k, rectOf(el)),
                    showHandle: false,
                  })}
                  {/* parallel siblings */}
                  {g.stages.slice(1).map((p, pk) => (
                    <span key={`p-${pk}`} className="relative flex items-center gap-1.5 pl-5 pr-1 self-stretch">
                      {/* 左侧弯曲线（视觉上"分叉"） */}
                      <span className="absolute left-1 top-0 bottom-1/2 w-4 border-l-2 border-b-2 border-line rounded-bl-lg" />
                      <span className="absolute left-5 top-1/2 bottom-0 w-px bg-line" />
                      {renderNode(p, {
                        onEdit: () => onEditParallel(k, pk + 1),
                        onDelete: () => onRemoveParallel(k, pk + 1),
                        showHandle: false,
                        size: "sm",
                      })}
                    </span>
                  ))}
                  {/* 在组末尾补一个 "+ 加并行任务" 小按钮（hover 显示） */}
                  {g.stages[0] && (
                    <button
                      onClick={(e) => onPickParallel(k, rectOf(e.currentTarget))}
                      className="opacity-0 group-hover/flow:opacity-100 transition-opacity text-[10px] text-brand-600 hover:text-brand-700 inline-flex items-center gap-0.5 mt-0.5"
                      title="给该主线节点添加并行任务"
                    >
                      <Plus size={9} /> 并行任务
                    </button>
                  )}
                </span>
                {/* 组间 Connector */}
                {renderConnector((el) => onPickMain(k + 1, el), false)}
              </span>
            ))}

            {hasSource && groupCount === 0 && (
              <span className="text-[11px] text-ink-400 italic ml-1">
                后续步骤在节点间用 <span className="inline-block align-middle w-3 h-3 rounded-full bg-ink-900 mx-0.5" /> 按钮插入
              </span>
            )}
          </div>
        </div>

        {/* 右侧管道操作（hover 显示） */}
        <div className="flex flex-col items-end gap-1 opacity-0 group-hover/flow:opacity-100 transition-opacity shrink-0">
          <button
            onClick={onEditSource}
            className="w-7 h-7 grid place-items-center rounded-md border border-line bg-white text-ink-500 hover:text-brand-600 hover:border-brand-300 transition"
            title={hasSource ? "编辑源节点" : "为此管道选源"}
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={onRemoveFlow}
            className="w-7 h-7 grid place-items-center rounded-md border border-line bg-white text-ink-500 hover:text-err hover:border-err/40 transition"
            title="删除整条管道"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {/* 管道尾部信息 */}
      <div className="mt-2 flex items-center gap-3 text-[10.5px] text-ink-400 font-mono">
        <span>{hasSource ? "起点：源 → " : "无源 · "}{groupCount} 个节点组{parallelCount > 0 ? ` · ${parallelCount} 个并行任务` : ""}</span>
        {!hasSource && <span className="text-warn">· 该管道尚未设置源</span>}
      </div>
    </div>
  );
}

// ---------- 浮层 Picker（fixed 定位到 anchor 按钮旁，避免被画布滚动条带跑） ----------
function PickerPopover({
  anchor,
  filterGroup,
  title,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  filterGroup?: "source" | "normal";
  title: string;
  onPick: (k: PipelineNodeKind) => void;
  onClose: () => void;
}) {
  // 定位策略：默认在 anchor 下方左对齐；空间不够则上方右对齐
  const PICKER_WIDTH = 640; // 估算最大宽度（grid-cols-4 + padding）
  const PICKER_HEIGHT = 200; // 估算高度
  const margin = 8;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 720;
  const fitsBelow = anchor.bottom + PICKER_HEIGHT + margin < viewportH;
  const fitsRight = anchor.left + PICKER_WIDTH + margin < viewportW;
  const top = fitsBelow ? anchor.bottom + margin : Math.max(margin, anchor.top - PICKER_HEIGHT - margin);
  const left = fitsRight ? anchor.left : Math.max(margin, anchor.right - PICKER_WIDTH);
  return (
    <>
      {/* 透明遮罩：点击空白处关闭（不影响其他按钮） */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-transparent"
        aria-hidden
      />
      <div
        className="fixed z-[70]"
        style={{ top, left, width: PICKER_WIDTH }}
      >
        <InsertPicker
          filterGroup={filterGroup}
          title={title}
          onPick={onPick}
          onClose={onClose}
        />
      </div>
    </>
  );
}

function InsertPicker({
  onPick, onClose, filterGroup, title,
}: { onPick: (k: PipelineNodeKind) => void; onClose: () => void; filterGroup?: "source" | "normal"; title?: string }) {
  const list = NODE_LIBRARY.filter((n) => !filterGroup || n.group === filterGroup);
  const def = title ?? (filterGroup === "source" ? "选择流水线源节点（并列启动）"
    : filterGroup === "normal" ? "选择构建步骤（顺序执行）"
    : "选择要插入的节点");
  return (
    <div className="rounded-xl border border-line bg-white shadow-sh-2 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[12px] font-semibold text-ink-800">{def}</div>
        <button onClick={onClose} className="w-6 h-6 grid place-items-center rounded text-ink-400 hover:bg-sunken"><X size={12} /></button>
      </div>
      <div className={cn("grid gap-2", filterGroup ? "grid-cols-4 max-w-2xl" : "grid-cols-5 max-w-3xl")}>
        {list.map((n) => {
          const c = colorClasses(n.color);
          return (
            <button
              key={n.key}
              onClick={() => onPick(n.key)}
              className={cn("rounded-lg border p-2.5 text-left hover:-translate-y-0.5 transition", c.wrap)}
              title={n.desc}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <n.icon size={13} className={c.icon} />
                <div className="text-[11.5px] font-medium">{n.label}</div>
              </div>
              <div className="text-[10px] text-ink-500 line-clamp-2">{n.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 配置表单字段（按 kind）
type ConfigField =
  | { key: string; label: string; type: "text" | "bool" | "textarea" | "image" | "file" | "select" | "password" | "namespace" | "registry" | "cluster" | "ports" | "env" | "volumes" | "probes"; placeholder?: string; options?: string[]; fileMode?: "backend" | "frontend"; fileField?: string; rows?: number; required?: boolean };
function configSchema(kind: PipelineNodeKind): ConfigField[] {
  switch (kind) {
    case "git": return [
      { key: "repo", label: "仓库地址", type: "text", placeholder: "git@github.com:org/repo.git 或 plat/my-service" },
      { key: "authMode", label: "鉴权方式", type: "select", options: ["none", "password", "credential"] },
      { key: "username", label: "用户名（账号密码模式）", type: "text", placeholder: "git" },
      { key: "password", label: "密码 / Token（账号密码模式）", type: "password", placeholder: "••••••••" },
      { key: "credential", label: "代码凭证名（凭证模式）", type: "text", placeholder: "选择已配置的 Git 凭证名" },
      { key: "baseImage", label: "基础镜像（从镜像仓库选）", type: "image", placeholder: "registry.local/.../base:tag" },
    ];
    case "backend": return [
      { key: "artifactPath", label: "后端构建包（jar / war / zip / tar.gz）", type: "file", fileMode: "backend", fileField: "artifactPath" },
      { key: "baseImage", label: "基础镜像（从镜像仓库选）", type: "image", placeholder: "registry.local/.../base:tag" },
    ];
    case "frontend": return [
      { key: "frontendPath", label: "前端构建产物（.zip）", type: "file", fileMode: "frontend", fileField: "frontendPath" },
      { key: "baseImage", label: "基础镜像（从镜像仓库选）", type: "image", placeholder: "registry.local/.../base:tag" },
    ];
    case "image": return [
      // 镜像节点只负责选定镜像，不再承载「目标命名空间 / 工作负载」—— 部署目标由 deploy 节点统一配置。
      { key: "image", label: "默认镜像（可手填或从镜像仓库选）", type: "image", placeholder: "registry.local/my-service:v1.2.3" },
    ];
    case "build": return [
      { key: "command", label: "构建命令", type: "textarea", rows: 8, placeholder: "前端：npm ci && npm run build\n后端：mvn -B package -DskipTests" },
    ];
    case "docker-build": return [
      { key: "registry", label: "镜像仓库（构建镜像归属仓库）", type: "registry" },
      { key: "dockerfileContent", label: "Dockerfile 内容（直接编写）", type: "textarea", rows: 10, placeholder: "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD [\"node\", \"dist/server.js\"]" },
      { key: "context", label: "构建上下文目录（COPY 相对路径）", type: "text", placeholder: "." },
      { key: "project", label: "项目名 / 命名空间", type: "text", placeholder: "project", required: true },
      { key: "imageName", label: "镜像名（留空用应用名）", type: "text", placeholder: "openjdk（留空则取流水线名）" },
      { key: "version", label: "版本号（留空随机生成）", type: "text", placeholder: "随机，如 v20260813-a1b2" },
      { key: "buildArgs", label: "构建参数（每行 KEY=VALUE）", type: "textarea", rows: 6, placeholder: "ENV=prod\nVERSION=1.0" },
      { key: "insecure", label: "跳过 TLS 校验（仅 podman 生效：关闭对自签/私有 CA 仓库的证书校验，覆盖 build 的 FROM pull 与 push。docker 模式需节点级 insecure-registries）", type: "bool" },
    ];
    case "push": return [
      { key: "registry", label: "目标镜像仓库", type: "registry" },
      { key: "project", label: "项目名 / 命名空间", type: "text", placeholder: "project", required: true },
      { key: "imageName", label: "镜像名（留空沿用上游构建镜像）", type: "text", placeholder: "openjdk（留空则取上游镜像名）" },
      { key: "version", label: "版本号（留空沿用上游）", type: "text", placeholder: "随机，如 v20260813-a1b2" },
      { key: "insecure", label: "跳过 TLS 校验（仅 podman 生效：关闭对自签/私有 CA 仓库的证书校验，覆盖 push 的 registry ping 与上传。docker 模式需节点级 insecure-registries）", type: "bool" },
    ];
    case "deploy": return [
      // —— 基础 ——
      { key: "kind", label: "工作负载类型", type: "select", options: ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"] },
      { key: "name", label: "工作负载名称", type: "text", placeholder: "payment-api（留空按镜像名派生）" },
      { key: "namespace", label: "目标命名空间（从集群选择）", type: "namespace" },
      { key: "replicas", label: "实例数量", type: "text", placeholder: "1" },
      // 镜像地址不再手填：统一由上游「镜像发布(image)」或「推送镜像(push)」节点产出，经引擎透传给部署。
      // —— 容器 ——
      { key: "command", label: "容器启动命令（空格分隔）", type: "text", placeholder: "java -jar $CATALINA_OPTS /app/yms.jar" },
      // —— 资源 ——
      { key: "cpu", label: "CPU 限制（毫核）", type: "text", placeholder: "500" },
      { key: "mem", label: "内存限制", type: "text", placeholder: "512Mi" },
      { key: "cpuReq", label: "CPU 请求（毫核，可选）", type: "text", placeholder: "100" },
      { key: "memReq", label: "内存请求（可选）", type: "text", placeholder: "128Mi" },
      // —— 高级（结构化填写，不再手填 JSON） ——
      { key: "ports_json", label: "容器端口", type: "ports" },
      { key: "env_json", label: "环境变量", type: "env" },
      { key: "volumes_json", label: "数据卷挂载", type: "volumes" },
      { key: "probes_json", label: "健康检查（存活/就绪/启动探针）", type: "probes" },
      // —— 调度 / CronJob ——
      { key: "priority", label: "Pod 优先级", type: "select", options: ["Normal", "High"] },
      { key: "schedule", label: "CronJob 调度周期（仅 CronJob）", type: "text", placeholder: "*/5 * * * *" },
      { key: "nodeSelector_json", label: "节点选择器（JSON 对象，可选）", type: "textarea", placeholder: '{"kubernetes.io/hostname":"node-a"}' },
    ];
    case "test": return [
      { key: "command", label: "测试命令", type: "textarea", rows: 6, placeholder: "make test\n# 或 go test ./..." },
    ];
    case "configmap": return [
      { key: "mode", label: "运行模式", type: "select", options: ["read", "write"], required: true,
        // 注：read=只读审计；write=整体覆盖 data（labels/annotations 保持原样）。
        // 这里的说明会在字段旁边的小字位置显示。
      },
      { key: "namespace", label: "命名空间", type: "text", placeholder: "default", required: true },
      { key: "name", label: "ConfigMap 名称", type: "text", placeholder: "app-config", required: true },
      { key: "data_json", label: "data 内容（仅 write 模式生效）", type: "textarea", rows: 10,
        placeholder: '{\n  "log.level": "INFO",\n  "feature.flag": "true",\n  "server.port": "8080"\n}' },
    ];
    case "notify": return [
      { key: "webhook", label: "Webhook URL", type: "text", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=..." },
      { key: "channel", label: "渠道（可选）", type: "text", placeholder: "dingtalk/feishu/slack/email" },
    ];
    case "wait": return [
      { key: "seconds", label: "等待秒数", type: "text", placeholder: "60" },
      { key: "approval", label: "审批门禁（可选）", type: "text", placeholder: "true/false" },
    ];
    default: return [];
  }
}

// —— 上传包格式校验（前端预校验，与服务端 magic bytes 规则保持一致）——
// ZIP / JAR / WAR : 50 4B 03 04（PK..），空归档 50 4B 05 06，分卷 50 4B 07 08
// GZIP / TAR.GZ   : 1F 8B 08
function readFileMagic(file: File): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer).slice(0, 8));
    r.onerror = () => resolve(new Uint8Array(0));
    r.readAsArrayBuffer(file.slice(0, 8));
  });
}
function isZipMagic(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const pk = (a: number, c: number) => b[0] === 0x50 && b[1] === 0x4b && b[2] === a && b[3] === c;
  return pk(0x03, 0x04) || pk(0x05, 0x06) || pk(0x07, 0x08);
}
function isGzipMagic(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;
}
function EditNodeModal({ draft, setDraft, config, setConfig, nodeKind, onSwitchKind, onClose, onSave, titleSuffix, libLabel, pipelineName, stageName, hasImageNode }: {
  draft: { name: string; desc: string };
  setDraft: (d: { name: string; desc: string }) => void;
  config: Record<string, string>;
  setConfig: (c: Record<string, string>) => void;
  nodeKind: PipelineNodeKind;
  onSwitchKind: (k: PipelineNodeKind) => void;
  onClose: () => void;
  onSave: () => void;
  titleSuffix?: string;
  libLabel: string;
  pipelineName: string;
  stageName: string;
  hasImageNode?: boolean;
}) {
  const lib = NODE_LIBRARY.find((n) => n.key === nodeKind) || NODE_LIBRARY[NODE_LIBRARY.length - 1];
  const c = colorClasses(lib.color);
  // 编辑某节点时，节点类型选择器只允许在同分组内切换（源节点↔源节点，普通节点↔普通节点），
  // 避免把「Git 仓库 / 已有镜像 / 上传后端包 / 上传前端包」误改成部署 / 编译等普通节点。
  const currentGroup = lib.group;
  const fields = configSchema(nodeKind);
  const setCfg = (k: string, v: string) => setConfig({ ...config, [k]: v });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string>("");
  const [uploadMsg, setUploadMsg] = useState<string>("");
  // Git 分支探测（检测仓库连通性后从远端同步分支列表）
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [gitProbing, setGitProbing] = useState(false);
  const [gitProbeMsg, setGitProbeMsg] = useState<string>("");
  const uploadFile = async (mode: "backend" | "frontend", fileField: string) => {
    const fileEl = fileInputRef.current;
    if (!fileEl || !fileEl.files || fileEl.files.length === 0) {
      setUploadErr("请先选择文件"); return;
    }
    const file = fileEl.files[0];
    // —— 客户端前置校验：扩展名白名单 + magic bytes（与服务端一致，失败即时反馈避免无谓上传）——
    const lower = file.name.toLowerCase();
    const ext = lower.endsWith(".tar.gz") ? ".tar.gz" : (lower.includes(".") ? "." + lower.split(".").pop()! : "");
    const allowed = mode === "backend" ? [".jar", ".war", ".zip", ".tar.gz", ".tgz", ".gz"] : [".zip"];
    if (!allowed.includes(ext)) {
      setUploadErr(`不支持的格式，仅支持：${allowed.join(" / ")}`);
      return;
    }
    const magic = await readFileMagic(file);
    if (mode === "backend") {
      if ((ext === ".jar" || ext === ".war" || ext === ".zip") && !isZipMagic(magic)) {
        setUploadErr("文件内容不是合法的 ZIP/JAR/WAR 格式（缺少 PK 魔数）");
        return;
      }
      if ((ext === ".tar.gz" || ext === ".tgz" || ext === ".gz") && !isGzipMagic(magic)) {
        setUploadErr("文件内容不是合法的 GZIP/TAR.GZ 格式（缺少 1F 8B 08 魔数）");
        return;
      }
    } else if (!isZipMagic(magic)) {
      setUploadErr("前端包内容不是合法的 ZIP 格式（缺少 PK 魔数）");
      return;
    }
    setUploading(true); setUploadErr("");
    try {
      const resp = await uploadPipelinePackage(pipelineName, mode, file, stageName);
      // resp 形如 { artifactPath/frontendPath: <abs path>, savedAs: <basename> }
      setCfg(fileField, (resp as any)[fileField] || (resp as any).savedAs || "");
      setUploadMsg(`上传成功：${(resp as any).savedAs || ""}`);
    } catch (e) {
      setUploadErr((e as Error).message);
    } finally {
      setUploading(false);
      if (fileEl) fileEl.value = "";
    }
  };
  // 检测 Git 仓库连通性并同步分支（按鉴权方式：none / password / credential）
  const gitAuth = config.authMode || "none";
  const probeGit = async () => {
    if (!config.repo) {
      setGitProbeMsg("请先填写仓库地址");
      return;
    }
    setGitProbing(true);
    setGitProbeMsg("");
    try {
      const r = await probeGitRepo({
        repo: config.repo,
        authMode: gitAuth,
        username: config.username,
        password: config.password,
        credential: config.credential,
      });
      if (r.ok) {
        setGitBranches(r.branches);
        if (!config.branch && r.branches.length > 0) setCfg("branch", r.branches[0]);
        setGitProbeMsg(`连通成功，检测到 ${r.branches.length} 个分支`);
      } else {
        setGitProbeMsg("检测失败：" + r.error);
      }
    } catch (e) {
      setGitProbeMsg("检测失败：" + (e as Error).message);
    } finally {
      setGitProbing(false);
    }
  };
  // 必填校验：对 configSchema(kind) 中 required 的字段逐个检查非空，缺则给出提示并不调 onSave。
  const [saveErr, setSaveErr] = useState<string>("");
  const handleSave = () => {
    for (const f of fields) {
      if (f.required && !(config[f.key] || "").trim()) {
        setSaveErr("请填写必填项：「" + f.label + "」");
        return;
      }
    }
    setSaveErr("");
    onSave();
  };
  return (
    <Modal
      open
      onClose={onClose}
      maxW="max-w-2xl"
      title={`编辑${titleSuffix || "节点"} · ${libLabel || lib.label}`}
      icon={<Pencil size={14} />}
      footer={
        <>
          <button onClick={onClose} className="h-8 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken">取消</button>
          <button onClick={handleSave} className="h-8 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95">保存</button>
        </>
      }
    >
      <div className="space-y-3">
        {/* 节点类型选择 */}
        <div>
          <div className="text-[10px] text-ink-400 mb-1">节点类型</div>
          <div className="grid grid-cols-3 gap-1.5">
            {NODE_LIBRARY.filter((n) => n.group === currentGroup).map((n) => {
              const active = n.key === nodeKind;
              const cc = colorClasses(n.color);
              return (
                <button
                  key={n.key}
                  onClick={() => onSwitchKind(n.key)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left text-[11px] flex items-center gap-1.5 transition",
                    cc.wrap,
                    !active && "opacity-60 hover:opacity-100",
                    active && "ring-2 ring-brand-300",
                  )}
                >
                  <n.icon size={11} className={cc.icon} />
                  <span>{n.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        {/* 节点名称 */}
        <div>
          <div className="text-[10px] text-ink-400 mb-1">节点名称</div>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="请输入节点名称"
            className="w-full h-9 px-2.5 text-[12.5px] rounded-md border border-line bg-surface outline-none focus:border-brand-300"
          />
        </div>
        {/* kind 专属配置表单 */}
        {fields.length > 0 && (
          <div className="rounded-lg border border-line bg-sunken/30 p-2.5 space-y-2.5">
            <div className="text-[10.5px] font-medium text-ink-700 flex items-center gap-1.5">
              <lib.icon size={11} className={c.icon} /> {lib.label} 配置
            </div>
            {fields.map((f) => {
              // Git 节点：按鉴权方式互斥显示 账号密码 / 凭证 字段
              if (nodeKind === "git" && (f.key === "username" || f.key === "password" || f.key === "credential")) {
                const show = f.key === "credential" ? gitAuth === "credential" : gitAuth === "password";
                if (!show) return null;
              }
              if (f.type === "file") {
                const val = config[f.key] || "";
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <div className="flex items-center gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        disabled={uploading}
                        accept={f.fileMode === "backend" ? ".jar,.war,.zip,.tar.gz,.tgz,.gz" : ".zip"}
                        className="flex-1 h-9 px-2 text-[12px] rounded-md border border-line bg-surface file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-brand-50 file:text-brand-700 file:text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() => uploadFile(f.fileMode!, f.fileField || f.key)}
                        disabled={uploading}
                        className="h-9 px-3 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12px] font-medium disabled:opacity-50"
                      >
                        {uploading ? "上传中…" : "上传"}
                      </button>
                    </div>
                    {val && (
                      <div className="mt-1 text-[10.5px] text-ink-500 font-mono break-all">
                        ✓ 已上传：{val.split("/").pop()}
                      </div>
                    )}
                    {uploadErr && (
                      <div className="mt-1 text-[10.5px] text-err">{uploadErr}</div>
                    )}
                    {uploadMsg && (
                      <div className="mt-1 text-[10.5px] text-ok">{uploadMsg}</div>
                    )}
                  </div>
                );
              }
              if (f.type === "image") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    {/* ImagePicker 内部自带选择按钮 */}
                    <div className="flex items-center gap-2">
                      <input
                        value={config[f.key] || ""}
                        onChange={(e) => setCfg(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        className="flex-1 h-9 px-2.5 text-[12px] rounded-md border border-line bg-surface outline-none focus:border-brand-300 font-mono"
                      />
                      <ImagePicker
                        value={config[f.key] || ""}
                        onChange={(v) => setCfg(f.key, v)}
                      />
                    </div>
                  </div>
                );
              }
              if (f.type === "textarea") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <LineNumberedTextArea
                      value={config[f.key] || ""}
                      onChange={(e) => setCfg(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={f.rows ?? 3}
                    />
                  </div>
                );
              }
              if (f.type === "ports" || f.type === "env" || f.type === "volumes" || f.type === "probes") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    {f.type === "ports" && <ContainerPortsEditor value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />}
                    {f.type === "env" && <EnvVarsEditor value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />}
                    {f.type === "volumes" && <VolumeMountsEditor value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />}
                    {f.type === "probes" && <ProbesEditor value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />}
                  </div>
                );
              }
              if (f.type === "password") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <input
                      type="password"
                      value={config[f.key] || ""}
                      onChange={(e) => setCfg(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full h-9 px-2.5 text-[12.5px] rounded-md border border-line bg-surface outline-none focus:border-brand-300 font-mono"
                    />
                  </div>
                );
              }
              if (f.type === "select") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <select
                      value={config[f.key] || (f.options?.[0] ?? "")}
                      onChange={(e) => setCfg(f.key, e.target.value)}
                      className="w-full h-9 px-2.5 text-[12px] rounded-md border border-line bg-surface outline-none focus:border-brand-300"
                    >
                      {(f.options || []).map((o) => (<option key={o} value={o}>{o}</option>))}
                    </select>
                  </div>
                );
              }
              if (f.type === "namespace") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <NamespaceSelect value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />
                  </div>
                );
              }
              if (f.type === "registry") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <RegistrySelect value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />
                  </div>
                );
              }
              if (f.type === "cluster") {
                return (
                  <div key={f.key}>
                    <div className="text-[10px] text-ink-500 mb-1">{f.label}</div>
                    <ClusterSelect value={config[f.key] || ""} onChange={(v) => setCfg(f.key, v)} />
                  </div>
                );
              }
              // bool（checkbox）
              if (f.type === "bool") {
                return (
                  <label key={f.key} className="flex items-start gap-2 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(config[f.key] || "") === "true"}
                      onChange={(e) => setCfg(f.key, e.target.checked ? "true" : "false")}
                      className="mt-0.5 accent-brand-600"
                    />
                    <span className="text-[11px] text-ink-600 leading-snug">{f.label}</span>
                  </label>
                );
              }
              // text
              return (
                <div key={f.key}>
                  <div className="text-[10px] text-ink-500 mb-1">
                    {f.label}
                    {f.required && <span className="text-err ml-0.5">*</span>}
                  </div>
                  <input
                    value={config[f.key] || ""}
                    onChange={(e) => setCfg(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    className={cn(
                      "w-full h-9 px-2.5 text-[12.5px] rounded-md border bg-surface outline-none focus:border-brand-300",
                      f.required && !(config[f.key] || "").trim() ? "border-err/60" : "border-line"
                    )}
                  />
                </div>
              );
            })}
            {/* Git 分支：检测连通性后从仓库同步为下拉可选 */}
            {nodeKind === "git" && (
              <div className="pt-2 mt-1 border-t border-line/60">
                <div className="flex items-center justify-between mb-1 mt-1">
                  <div className="text-[10px] text-ink-500">分支（检测后从仓库同步选择）</div>
                  <button
                    type="button"
                    onClick={probeGit}
                    disabled={gitProbing || !config.repo}
                    className="h-7 px-2.5 rounded-md border border-brand-300 bg-brand-50 text-[11px] text-brand-700 hover:bg-brand-100 disabled:opacity-40 flex items-center gap-1"
                  >
                    <GitBranch size={11} /> {gitProbing ? "检测中…" : "检测连通性"}
                  </button>
                </div>
                {gitProbeMsg && (
                  <div className={cn("mb-1 text-[10.5px]", gitProbeMsg.startsWith("检测失败") ? "text-err" : "text-ok")}>{gitProbeMsg}</div>
                )}
                {gitBranches.length > 0 ? (
                  <select
                    value={config.branch || gitBranches[0]}
                    onChange={(e) => setCfg("branch", e.target.value)}
                    className="w-full h-9 px-2.5 text-[12px] rounded-md border border-line bg-surface outline-none focus:border-brand-300"
                  >
                    {Array.from(new Set([...(config.branch ? [config.branch] : []), ...gitBranches])).map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={config.branch || ""}
                    onChange={(e) => setCfg("branch", e.target.value)}
                    placeholder="main"
                    className="w-full h-9 px-2.5 text-[12px] rounded-md border border-line bg-surface outline-none focus:border-brand-300 font-mono"
                  />
                )}
              </div>
            )}
          </div>
        )}
        {saveErr && (
          <div className="rounded-md border border-err/40 bg-red-50 px-2.5 py-1.5 text-[11.5px] text-err">
            {saveErr}
          </div>
        )}
        {nodeKind === "deploy" && !hasImageNode && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
            部署节点不填写镜像：镜像地址统一取自上游「镜像发布」或「推送镜像」节点。请在上游添加其中之一，否则运行时会因缺少镜像而失败。
          </div>
        )}
        {nodeKind === "push" && (
          <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] text-violet-700 font-mono">
            镜像引用预览：{config.registry || "registry.local"}/{config.imageName || pipelineName}:{config.version || "v…(随机生成)"}
            <div className="text-[10px] text-violet-500 mt-0.5 not-italic">运行时会按该引用 docker build &amp; push，下游「部署」节点自动复用此镜像。</div>
          </div>
        )}
        {/* 节点说明 */}
        <div>
          <div className="text-[10px] text-ink-400 mb-1">节点说明（可选）</div>
          <textarea
            value={draft.desc}
            onChange={(e) => setDraft({ ...draft, desc: e.target.value })}
            rows={2}
            placeholder="例如：使用已打好的 payment-api:v1.8.2 镜像"
            className="w-full px-2.5 py-1.5 text-[12.5px] rounded-md border border-line bg-surface outline-none focus:border-brand-300 resize-none"
          />
        </div>
        {/* kind 说明 */}
        <div className={cn("rounded-lg border px-2.5 py-1.5 text-[11px]", c.wrap)}>
          <lib.icon size={11} className={cn("inline mr-1", c.icon)} /> {lib.desc}
        </div>
      </div>
    </Modal>
  );
}