import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { AlertTriangle, X, ChevronLeft, ChevronRight, ChevronDown, Search } from "lucide-react";

// ============ 卡片 ============
export function Card({
  children, className, beam = true, hover = false,
}: { children: ReactNode; className?: string; beam?: boolean; hover?: boolean }) {
  return (
    <div
      className={cn(
        "relative bg-surface rounded-lg border border-line shadow-sh-2",
        beam && "card-beam",
        hover && "hover-glow",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5">
      <div>
        <h3 className="text-[13px] font-semibold text-ink-900 tracking-tight">{title}</h3>
        {sub && <p className="text-[11px] text-ink-400 mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

// ============ 主操作按钮（渐变实心，强调创建类操作） ============
export function PrimaryButton({
  icon, children, onClick, className,
}: { icon?: ReactNode; children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium whitespace-nowrap shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 hover:shadow-[0_4px_14px_-2px_rgba(19,96,196,.55)] active:translate-y-px transition",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ============ 次级按钮（描边，用于取消等） ============
export function GhostButton({
  children, onClick, className,
}: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ============ 状态映射 ============
const statusMap: Record<string, { label: string; dot: string; text: string; bg: string; pulse?: boolean }> = {
  ok: { label: "正常", dot: "bg-ok", text: "text-ok", bg: "bg-ok-bg" },
  warn: { label: "告警", dot: "bg-warn", text: "text-warn", bg: "bg-warn-bg" },
  err: { label: "异常", dot: "bg-err", text: "text-err", bg: "bg-err-bg" },
  info: { label: "信息", dot: "bg-info", text: "text-info", bg: "bg-info-bg" },
  idle: { label: "空闲", dot: "bg-idle", text: "text-idle", bg: "bg-idle-bg" },
  running: { label: "运行中", dot: "bg-info", text: "text-info", bg: "bg-info-bg", pulse: true },
  pending: { label: "等待", dot: "bg-idle", text: "text-idle", bg: "bg-idle-bg" },
  updating: { label: "更新中", dot: "bg-info", text: "text-info", bg: "bg-info-bg", pulse: true },
};

export function StatusBadge({ kind, label }: { kind: string; label?: string }) {
  const s = statusMap[kind] ?? statusMap.idle;
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium", s.bg, s.text)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", s.dot, s.pulse && "animate-pulse-ring")} />
      {label ?? s.label}
    </span>
  );
}

export function StatusDot({ kind }: { kind: string }) {
  const s = statusMap[kind] ?? statusMap.idle;
  return <span className={cn("inline-block w-2 h-2 rounded-full", s.dot, s.pulse && "animate-pulse-ring")} />;
}

// ============ 区块标题 ============
export function SectionTitle({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div className="flex items-center gap-2">
        <span className="w-1 h-4 rounded-full bg-gradient-to-b from-brand-600 to-cyan-500" />
        <div>
          <h2 className="text-[15px] font-semibold text-ink-900 tracking-tight leading-none">{title}</h2>
          {desc && <p className="text-[11px] text-ink-400 mt-1">{desc}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

// ============ KPI 卡（贴设计稿：顶部光条默认 1/3 宽，hover 展开；右下角径向光晕） ============
export function KpiStat({
  label, value, unit, delta, deltaUp, icon, accent = "brand",
}: {
  label: string; value: string | number; unit?: string; delta?: string;
  deltaUp?: boolean; icon: ReactNode; accent?: "brand" | "cyan" | "ok" | "warn" | "err";
}) {
  const accentMap = {
    brand: "text-brand-600 bg-brand-50",
    cyan: "text-cyan-600 bg-cyan-100",
    ok: "text-ok bg-ok-bg",
    warn: "text-warn bg-warn-bg",
    err: "text-err bg-err-bg",
  } as const;
  return (
    <div className="group relative bg-surface rounded-lg border border-line shadow-sh-1 p-4 overflow-hidden transition duration-200 hover:shadow-sh-2 hover:-translate-y-px hover:border-brand-300">
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-brand-500 to-cyan-400 origin-left scale-x-[.32] transition-transform duration-300 group-hover:scale-x-100" />
      <div className="absolute -right-6 -bottom-8 w-24 h-24 rounded-full bg-[radial-gradient(circle,rgba(36,120,232,.09),transparent_68%)]" />
      <div className="relative flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2.5">
            <div className={cn("w-[26px] h-[26px] rounded-lg grid place-items-center", accentMap[accent])}>{icon}</div>
            <span className="text-[11.5px] text-ink-500 font-medium truncate">{label}</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-[27px] font-semibold text-ink-900 leading-none tracking-tight tabular-nums">{value}</span>
            {unit && <span className="text-[12px] text-ink-400 font-medium">{unit}</span>}
          </div>
        </div>
      </div>
      {delta && (
        <div className="relative mt-2.5 flex items-center gap-1 text-[11px]">
          <span className={cn("font-mono font-semibold", deltaUp ? "text-err" : "text-ok")}>{delta}</span>
          <span className="text-ink-300">较昨日</span>
        </div>
      )}
    </div>
  );
}

// ============ 迷你趋势图 ============
export function Sparkline({ data, color = "#2478E8" }: { data: number[]; color?: string }) {
  const d = data.map((v, i) => ({ i, v }));
  const id = `sl-${color.replace("#", "")}`;
  return (
    <div className="h-8 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={d} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#${id})`} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============ 柱状 spark（贴设计稿流水线卡片） ============
export function Sparkbars({
  data, base = "#0EA36B", errAt = [], warnAt = [],
}: { data: number[]; base?: string; errAt?: number[]; warnAt?: number[] }) {
  return (
    <div className="flex items-end gap-[2.5px] h-[26px]">
      {data.map((v, i) => {
        const c = errAt.includes(i) ? "#E0453C" : warnAt.includes(i) ? "#E08600" : base;
        return (
          <div key={i} className="flex-1 rounded-t-[2px]" style={{ height: `${Math.max(10, v)}%`, background: c, opacity: 0.88 }} />
        );
      })}
    </div>
  );
}

// ============ 构建历史条（每格 = 一次构建，颜色 = 状态） ============
// 用于流水线卡片上的"最近 N 次构建历史"可视化。清新风格：浅 pastel 背景 + 细边线 + 舒展间距。
// statuses 顺序：最新在前（数组 index 0 = 最新构建）。空数组时显示「暂无构建」。
const BUILD_STRIP_STYLE: Record<string, { bg: string; ring: string; label: string }> = {
  ok:      { bg: "bg-emerald-50",  ring: "ring-emerald-300/70", label: "成功" },
  err:     { bg: "bg-rose-50",     ring: "ring-rose-300/70",    label: "失败" },
  running: { bg: "bg-sky-50",      ring: "ring-sky-300/70",     label: "运行中" },
  aborted: { bg: "bg-slate-50",    ring: "ring-slate-300/70",   label: "中止" },
};

export function BuildHistoryStrip({
  statuses, max = 20,
}: { statuses: string[]; max?: number }) {
  const list = (statuses ?? []).slice(0, max);
  if (list.length === 0) {
    return (
      <div className="h-7 rounded-md bg-sunken/40 ring-1 ring-line/60 text-[10.5px] text-ink-400 grid place-items-center font-mono tracking-wide">
        暂无构建
      </div>
    );
  }
  return (
    <div className="h-7 rounded-md bg-sunken/40 ring-1 ring-line/60 px-2 flex items-center gap-[5px]">
      {list.map((s, i) => {
        const st = BUILD_STRIP_STYLE[s] ?? { bg: "bg-slate-50", ring: "ring-slate-300/70", label: s };
        return (
          <div
            key={i}
            title={`#${list.length - i} · ${st.label}`}
            className={cn(
              "flex-1 h-3.5 rounded-[3px] cursor-help transition-all duration-150",
              st.bg,
              "ring-1",
              st.ring,
              "hover:scale-y-110",
            )}
            style={{ transformOrigin: "center" }}
          />
        );
      })}
    </div>
  );
}

// ============ 内联资源条（节点表等） ============
export function MiniGauge({ value, tone }: { value: number; tone?: "ok" | "warn" | "err" }) {
  const bar = tone === "err" ? "bg-err" : tone === "warn" ? "bg-warn" : "bg-gradient-to-r from-brand-600 to-cyan-500";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="w-14 h-[7px] rounded-full bg-sunken overflow-hidden">
        <span className={cn("block h-full rounded-full", bar)} style={{ width: `${value}%` }} />
      </span>
      <span className="font-mono text-[11.5px] text-ink-500 tabular-nums">{value}%</span>
    </span>
  );
}

// ============ 通用弹窗 ============
export function Modal({
  open, onClose, title, desc, icon, footer, maxW = "max-w-lg", bodyClassName, children,
}: {
  open: boolean; onClose: () => void; title: string; desc?: string;
  icon?: ReactNode; footer?: ReactNode; maxW?: string;
  bodyClassName?: string; // 自定义内容区 class（覆盖默认 p-4 space-y-3.5），用于「去掉顶部留白」等场景
  children?: ReactNode;
}) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center bg-ink-900/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className={cn("w-full rounded-xl border border-line bg-surface shadow-sh-3 overflow-hidden card-beam flex flex-col max-h-[90vh]", maxW)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line bg-subtle">
          {icon && <span className="text-brand-600">{icon}</span>}
          <div className="min-w-0">
            <h3 className="text-[13.5px] font-semibold text-ink-900 leading-none">{title}</h3>
            {desc && <p className="text-[11px] text-ink-400 mt-1 truncate">{desc}</p>}
          </div>
          <button onClick={onClose} className="ml-auto w-7 h-7 grid place-items-center rounded-md text-ink-400 hover:bg-sunken transition">
            <X size={15} />
          </button>
        </div>
        <div className={cn("p-4 space-y-3.5 flex-1 min-h-0 overflow-y-auto", bodyClassName)}>{children}</div>
        {footer && <div className="px-4 py-3 border-t border-line bg-subtle flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ============ 表单控件 ============
const inputCls =
  "w-full h-9 px-3 text-[12.5px] rounded-md border border-line bg-surface text-ink-900 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100 transition placeholder:text-ink-300";

export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("block", className)}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-medium text-ink-700">{label}</span>
        {hint && <span className="text-[10.5px] text-ink-300">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={cn(inputCls, className)} {...rest} />;
}

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <select className={cn(inputCls, "appearance-none cursor-pointer pr-8 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%238492A9%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-no-repeat bg-[right_0.6rem_center]", className)} {...rest}>
      {children}
    </select>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea className={cn("w-full font-mono text-[12px] text-ink-800 bg-sunken border border-line rounded-lg p-3 outline-none focus:border-brand-300 resize-none leading-relaxed", className)} {...rest} />;
}

/**
 * 带行号的 textarea：左侧固定宽度 gutter 显示行号（1-based），与右侧编辑区滚动同步。
 *
 * 关键：行号按"视觉行数"计数 —— 长命令被 CSS 自动折行后仍然只算 1 个行号，
 *       不会因为复制源里有隐藏 \n 而误判成多行。
 *
 * 实现方式：渲染一个与 textarea 同宽同字体的隐藏 mirror div，依次放入每个逻辑行
 * （按 `\n` 切分），测量其 offsetHeight / lineHeight 得到该逻辑行的视觉行数。
 * 行号在垂直方向用真实像素行高对齐 textarea 文本行；gutter 高度由 flex stretch
 * 自动匹配 textarea，内容多少都不会撑高外层容器（外层 wrapper 也不会被 resize）。
 *
 * 用法与原生 `<textarea>` 一致，支持 `value/onChange/placeholder/rows/className/style` 等。
 */
export function LineNumberedTextArea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const { className, style, rows = 3, ...rest } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // 每个逻辑行展开成几个视觉行；空内容时退化为 [minRows]，让 gutter 看起来与 textarea rows 对齐
  const [rowsPerLine, setRowsPerLine] = useState<number[]>([Math.max(Number(rows) || 3, 3)]);
  // 真实像素行高（用于 gutter 行号 div 的 height/line-height，与 textarea 文本对齐）
  const [lineHeightPx, setLineHeightPx] = useState<number>(18);

  const value = typeof props.value === "string" ? props.value : "";
  const minRows = Math.max(Number(rows) || 3, 3);

  // 剥离 caller 传入的 resize-* 类，避免外层 wrapper 被允许拖拽（CSS resize 对
  // overflow-hidden 元素生效）；textarea 内部永远是 resize-none。
  const safeClassName = className
    ? className.split(/\s+/).filter((c) => !/^resize-/i.test(c)).join(" ")
    : undefined;

  // 用隐藏 mirror div（与 textarea 同宽同字体）测量每个逻辑行的视觉行数
  const recompute = useCallback(() => {
    const ta = taRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const taStyle = getComputedStyle(ta);
    const fontSize = parseFloat(taStyle.fontSize) || 12;
    // lineHeight: normal 情况下 parseFloat 会返回 NaN，回退到 1.5 倍字号
    let lh = parseFloat(taStyle.lineHeight);
    if (!isFinite(lh) || lh <= 0) lh = fontSize * 1.5;
    setLineHeightPx(lh);

    const padL = parseFloat(taStyle.paddingLeft) || 0;
    const padR = parseFloat(taStyle.paddingRight) || 0;
    // mirror 同步 textarea 的字体/盒模型/换行行为
    mirror.style.font = taStyle.font;
    mirror.style.lineHeight = taStyle.lineHeight;
    mirror.style.letterSpacing = taStyle.letterSpacing;
    mirror.style.textTransform = taStyle.textTransform;
    mirror.style.padding = "0";
    mirror.style.border = "0";
    mirror.style.boxSizing = taStyle.boxSizing;
    mirror.style.width = `${Math.max(1, ta.clientWidth - padL - padR)}px`;
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflowWrap = "break-word";

    // 归一化换行符
    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // 空内容：直接给 minRows 个独立行号（每个 1 视觉行），渲染时 idx+1 自然得到 1,2,3…N
    // —— 否则把唯一一个逻辑行撑成 minRows 个视觉行，会让所有视觉行共享 idx=0，行号全显示"1"
    if (normalized.length === 0) {
      setRowsPerLine(Array(minRows).fill(1));
      return;
    }
    const lines = normalized.split("\n");
    const arr: number[] = [];
    for (const line of lines) {
      // 空行用零宽字符占位，保证有 1 行高度
      mirror.textContent = line.length === 0 ? "\u200B" : line;
      arr.push(Math.max(1, Math.round(mirror.offsetHeight / lh)));
    }
    setRowsPerLine(arr);
  }, [value, minRows]);

  // value/rows 变化后立即重测（useLayoutEffect 在 DOM 更新后同步触发，避免闪烁）
  useLayoutEffect(() => { recompute(); }, [recompute]);

  // textarea 大小变化（容器变宽、用户调字号）时也要重测
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(ta);
    return () => ro.disconnect();
  }, [recompute]);

  // 滚动同步：textarea scrollTop → gutter 内层 translateY
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onScroll = () => setScrollTop(ta.scrollTop);
    ta.addEventListener("scroll", onScroll, { passive: true });
    return () => ta.removeEventListener("scroll", onScroll);
  }, []);

  // gutter 宽度按最大行号位数自适应（tabular-nums + 右侧留白）
  const maxLineNo = rowsPerLine.length;
  const gutterWidthEm = Math.max(2.2, String(Math.max(maxLineNo, 1)).length * 0.95 + 1.4);

  return (
    <div
      className={cn(
        "relative flex w-full font-mono text-[12px] leading-relaxed bg-sunken border border-line rounded-lg overflow-hidden focus-within:border-brand-300 transition",
        safeClassName,
      )}
      style={style}
    >
      {/* 行号 gutter：与 textarea 同高（flex stretch），行号 absolute 不参与 flow */}
      <div
        aria-hidden
        className="relative shrink-0 select-none overflow-hidden bg-surface/60 border-r border-line"
        style={{
          width: `${gutterWidthEm}em`,
          // 与 textarea 的 py-1.5 (0.375rem) 单位一致（gutter 字号 12px，em 会算成 4.5px，跟 rem 6px 错位 1.5px）
          paddingTop: "0.375rem",
          paddingBottom: "0.375rem",
        }}
      >
        <div
          style={{
            position: "absolute",
            // 必须用 top: 0.375rem（= textarea 的 py-1.5 padding-top），
            // 抵消绝对定位对父元素 padding 的无响应 —— 否则第一行号会比 textarea
            // 第一行文本高 6px（这就是"数字偏高"的根因）
            top: "0.375rem",
            left: 0,
            right: 0,
            transform: `translateY(${-scrollTop}px)`,
          }}
        >
          {rowsPerLine.map((vr, idx) => (
            <Fragment key={idx}>
              {Array.from({ length: vr }, (_, i) => (
                <div
                  key={i}
                  // 行号：去掉 flex items-center 改用 block + 显式 line-height，
                  // 让行号的行内布局与 textarea 完全一致（12px 字 / 19.5px 行高），
                  // baseline 才会贴合。text-right 替代 justify-end，pr-1.5 留右内边距。
                  className="text-right font-mono tabular-nums text-ink-400/90 pr-1.5"
                  style={{
                    height: `${lineHeightPx}px`,
                    lineHeight: `${lineHeightPx}px`,
                  }}
                >
                  {idx + 1}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      <textarea
        {...rest}
        rows={rows}
        ref={taRef}
        className="flex-1 min-w-0 bg-transparent text-ink-800 outline-none resize-none px-2.5 py-1.5"
      />
      {/* 隐藏 mirror：与 textarea 同宽同字体，临时放单行文本用于测量视觉行数 */}
      <div
        ref={mirrorRef}
        aria-hidden
        style={{
          position: "absolute",
          visibility: "hidden",
          top: 0,
          left: 0,
          pointerEvents: "none",
          whiteSpace: "pre-wrap",
        }}
      />
    </div>
  );
}

// ============ 可搜索下拉（组合框）：解决原生 select 选项过多无法检索的问题 ============
export interface SearchSelectOption {
  value: string;
  label: string;
  sub?: string;
}

export function SearchSelect({
  value, onChange, options, placeholder = "请选择…", emptyText = "无匹配项",
  searchPlaceholder = "输入关键字搜索…", className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  emptyText?: string;
  searchPlaceholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? options.filter((o) => (o.label + " " + (o.sub ?? "")).toLowerCase().includes(needle))
    : options;
  const current = options.find((o) => o.value === value);

  // 打开时测量触发框位置（portal 用 fixed 定位，避免被弹窗 overflow 裁切）
  useEffect(() => {
    if (open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
      setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current && !wrapRef.current.contains(t) && !(document.getElementById("ss-portal")?.contains(t))) {
        setOpen(false);
        setQ("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // 弹窗/页面滚动时关闭下拉，避免错位；但下拉面板内部的滚动不关闭（否则一滚就收起）
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && document.getElementById("ss-portal")?.contains(t)) return;
      setOpen(false);
      setQ("");
    };
    const onResize = () => { setOpen(false); setQ(""); };
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) choose(filtered[active].value); }
    else if (e.key === "Escape") { setOpen(false); setQ(""); }
  };

  return (
    <div className={cn("relative", className)} ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          inputCls, "flex items-center justify-between text-left",
          open && "border-brand-300 ring-2 ring-brand-100",
        )}
      >
        <span className={cn("truncate font-mono", current ? "text-ink-900" : "text-ink-300")}>
          {current ? current.label : placeholder}
        </span>
        <ChevronDown size={13} className={cn("shrink-0 text-ink-400 transition", open && "rotate-180")} />
      </button>
      {open && pos && createPortal(
        <div
          id="ss-portal"
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          className="z-[60] max-w-[560px] rounded-lg border border-line bg-surface shadow-sh-3 overflow-hidden"
        >
          <div className="p-2 border-b border-line">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                className="w-full h-8 pl-7 pr-2.5 text-[12px] rounded-md border border-line bg-sunken outline-none focus:border-brand-300 text-ink-900 placeholder:text-ink-300"
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-ink-300">{emptyText}</div>
            ) : (
              filtered.map((o, i) => (
                <button
                  type="button"
                  key={o.value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 flex items-start gap-2 text-[12.5px]",
                    i === active ? "bg-brand-50 text-brand-700" : "text-ink-700 hover:bg-sunken",
                    o.value === value && "font-medium",
                  )}
                >
                  <span className="font-mono break-all leading-snug">{o.label}</span>
                  {o.sub && <span className="shrink-0 text-[11px] text-ink-400 font-mono ml-auto mt-0.5">{o.sub}</span>}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ============ 错误提示横幅（集群 / 镜像仓库 / 通用） ============
export function ErrorBanner({ msg, kind = "cluster", title: customTitle, hint: customHint }: { msg: string; kind?: "cluster" | "registry" | "generic"; title?: string; hint?: string }) {
  const title = customTitle ?? (
    kind === "registry" ? "无法连接镜像仓库" :
    kind === "generic"  ? "加载失败" :
    "无法连接真实集群"
  );
  const hint = customHint ?? (
    kind === "registry" ? "请在「镜像仓库」页检查该连接的 URL / 凭证，或确认网络可达性。下方为本地演示数据占位。" :
    kind === "generic"  ? "请稍后重试，或检查网络与服务状态。" :
    "请在「集群管理」中注册该集群的 KubeConfig，或检查控制面网络连通性。下方为本地演示数据占位。"
  );
  return (
    <div className="flex items-start gap-2 rounded-lg border border-err/30 bg-err-bg px-3.5 py-2.5 mb-4">
      <AlertTriangle size={15} className="text-err mt-0.5 shrink-0" />
      <div className="text-[12px] text-err leading-relaxed">
        <span className="font-semibold">{title}：</span>
        {msg}
        <div className="text-ink-400 mt-0.5">{hint}</div>
      </div>
    </div>
  );
}

// ============ 加载骨架屏（切菜单不闪 mock 数据，统一加载态） ============
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn("rounded-md bg-gradient-to-r from-sunken via-brand-50 to-sunken bg-[length:200%_100%] animate-shimmer", className)}
    />
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-line last:border-0">
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-4 py-2.5">
              <Skeleton className="h-4 w-full max-w-[140px]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function KpiSkeleton({
  label, icon, accent = "brand",
}: { label: string; icon: ReactNode; accent?: "brand" | "cyan" | "ok" | "warn" | "err" }) {
  const accentMap = {
    brand: "text-brand-600 bg-brand-50",
    cyan: "text-cyan-600 bg-cyan-100",
    ok: "text-ok bg-ok-bg",
    warn: "text-warn bg-warn-bg",
    err: "text-err bg-err-bg",
  } as const;
  return (
    <div className="group relative bg-surface rounded-lg border border-line shadow-sh-1 p-4 overflow-hidden transition duration-200 hover:shadow-sh-2 hover:-translate-y-px hover:border-brand-300">
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-brand-500 to-cyan-400 origin-left scale-x-[.32]" />
      <div className="relative flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2.5">
            <div className={cn("w-[26px] h-[26px] rounded-lg grid place-items-center", accentMap[accent])}>{icon}</div>
            <span className="text-[11.5px] text-ink-500 font-medium truncate">{label}</span>
          </div>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-16 mt-2.5" />
        </div>
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 py-2 border-b border-line/70 last:border-0">
          <Skeleton className="h-6 w-6 rounded-full shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </>
  );
}

// ============ 分页 ============
export function usePagination(total: number, initialPageSize = 10) {
  const [page, setPageRaw] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(initialPageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const setPage = (p: number) => setPageRaw(Math.min(Math.max(1, Math.round(p)), totalPages));
  const setPageSize = (s: number) => {
    setPageSizeRaw(s);
    setPageRaw(1);
  };
  const slice = <T,>(arr: T[]): T[] => (Array.isArray(arr) ? arr.slice(start, start + pageSize) : []);
  return { page: current, pageSize, setPage, setPageSize, totalPages, start, end, slice, total };
}

export function Pagination({
  page, totalPages, start, end, total, pageSize, onPageChange, onPageSizeChange,
}: {
  page: number; totalPages: number; start: number; end: number; total: number;
  pageSize: number; onPageChange: (p: number) => void; onPageSizeChange: (s: number) => void;
}) {
  const pageBtn = (p: number, label: ReactNode, opts: { active?: boolean; disabled?: boolean }, key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => !opts?.disabled && onPageChange(p)}
      disabled={opts?.disabled}
      className={cn(
        "h-7 min-w-7 px-2 rounded-md text-[11.5px] font-mono tabular-nums transition inline-flex items-center justify-center",
        opts?.active ? "bg-brand-600 text-white" : "border border-line bg-surface text-ink-600 hover:border-brand-300 hover:text-brand-700",
        opts?.disabled && "opacity-40 cursor-not-allowed hover:border-line hover:text-ink-600",
      )}
    >{label ?? p}</button>
  );
  const pages: (number | "…")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    const left = Math.max(2, page - 1);
    const right = Math.min(totalPages - 1, page + 1);
    if (left > 2) pages.push("…");
    for (let i = left; i <= right; i++) pages.push(i);
    if (right < totalPages - 1) pages.push("…");
    pages.push(totalPages);
  }
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-line bg-subtle/50">
      <div className="text-[11px] text-ink-400 font-mono tabular-nums whitespace-nowrap">
        共 {total} 条 · 第 {total === 0 ? 0 : start + 1}-{end} 条
      </div>
      <div className="flex items-center gap-1.5">
        {pageBtn(page - 1, <ChevronLeft size={13} />, { disabled: page <= 1 }, "prev")}
        {pages.map((p, i) =>
          p === "…"
            ? <span key={`e${i}`} className="text-ink-300 text-[11px] px-0.5 select-none">…</span>
            : pageBtn(p, p, { active: p === page }, `p${p}`),
        )}
        {pageBtn(page + 1, <ChevronRight size={13} />, { disabled: page >= totalPages }, "next")}
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="h-7 ml-1 rounded-md border border-line bg-surface text-[11.5px] text-ink-600 px-1.5 outline-none focus:border-brand-300 cursor-pointer"
        >
          {[10, 20, 50].map((s) => <option key={s} value={s}>{s}/页</option>)}
        </select>
      </div>
    </div>
  );
}
