import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "@/lib/api";
import { cn } from "@/lib/utils";

interface LogPanelProps {
  cluster: string;
  ns: string;
  pod: string;
  container: string;
  initialLines?: number;
}

type Status = "loading" | "streaming" | "error" | "closed";

// 容器日志面板：以 chunked 流消费后端 /api/pod-logs（fetch + ReadableStream），
// 支持实时追加、自动滚动、暂停与下载。零额外依赖。
export function LogPanel({ cluster, ns, pod, container, initialLines = 200 }: LogPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let aborted = false;
    const ctrl = new AbortController();
    setLines([]);
    setStatus("loading");
    setErrorMsg("");

    (async () => {
      try {
        const token = await getAuthToken();
        const qs = new URLSearchParams({ cluster, ns, pod, container, tail: String(initialLines), follow: "true" });
        const res = await fetch(`/api/pod-logs?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          if (!aborted) {
            setErrorMsg(t || `HTTP ${res.status}`);
            setStatus("error");
          }
          return;
        }
        if (!res.body) {
          if (!aborted) setStatus("closed");
          return;
        }
        setStatus("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          if (parts.length) {
            setLines((prev) => {
              const next = prev.concat(parts);
              return next.length > 4000 ? next.slice(next.length - 4000) : next;
            });
          }
        }
        if (!aborted) setStatus("closed");
      } catch (e) {
        if (!aborted && (e as Error).name !== "AbortError") {
          setErrorMsg((e as Error).message || String(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      aborted = true;
      ctrl.abort();
    };
  }, [cluster, ns, pod, container, initialLines]);

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const download = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pod}-${container}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusLabel: Record<Status, string> = {
    loading: "连接中",
    streaming: "实时",
    error: "错误",
    closed: "已结束",
  };
  const statusCls: Record<Status, string> = {
    loading: "bg-amber-500/20 text-amber-300",
    streaming: "bg-cyan-500/20 text-cyan-300",
    error: "bg-red-500/20 text-red-300",
    closed: "bg-sunken text-ink-400",
  };

  return (
    <div className="flex flex-col h-full rounded-lg border border-line overflow-hidden bg-[#0b1220]">
      <div className="flex items-center gap-2 px-3 py-2 bg-[#111c30] border-b border-line/60 shrink-0">
        <span className="text-[11px] font-mono text-[#9fb6d6] truncate">
          {pod} / {container}
        </span>
        <span className={cn("ml-auto text-[10px] px-1.5 py-0.5 rounded", statusCls[status])}>{statusLabel[status]}</span>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          className={cn(
            "text-[10.5px] px-2 py-0.5 rounded border transition",
            autoScroll ? "border-cyan-500/40 text-cyan-300" : "border-line text-ink-400",
          )}
        >
          {autoScroll ? "自动滚动" : "已暂停"}
        </button>
        <button
          onClick={download}
          className="text-[10.5px] px-2 py-0.5 rounded border border-line text-ink-300 hover:text-ink-100 transition"
        >
          下载
        </button>
      </div>
      <div
        ref={bodyRef}
        className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-[#cfe0f5] whitespace-pre-wrap break-words"
      >
        {status === "error" ? (
          <span className="text-red-400">{errorMsg}</span>
        ) : lines.length === 0 ? (
          <span className="text-[#5f7390]">等待日志…</span>
        ) : (
          lines.join("\n")
        )}
      </div>
    </div>
  );
}
