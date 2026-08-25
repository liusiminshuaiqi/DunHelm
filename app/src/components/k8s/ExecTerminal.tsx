import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getAuthToken } from "@/lib/api";

interface ExecTerminalProps {
  cluster: string;
  ns: string;
  pod: string;
  container: string;
  command?: string;
}

// 容器控制台终端：xterm 渲染，经 WebSocket 桥接后端 kubectl exec（TTY）。
// stdin 以 binary 帧发送，resize 以 text(JSON) 帧发送（对应后端 wsExecReader）。
//
// 注意：为避免 React 19 StrictMode 在开发环境下「挂载→卸载→再挂载」导致第一个已被
// dispose 的终端触发异步渲染（Viewport.syncScrollArea 读到 undefined 的 dimensions），
// 这里把 term.open() 推迟到 setTimeout(0) 宏任务：同步的 cleanup 会先取消首个挂载的
// 定时器，最终只有一次真正的 open，避免渲染崩溃。
export function ExecTerminal({ cluster, ns, pod, container, command = "/bin/sh" }: ExecTerminalProps) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let ws: WebSocket | null = null;
    let disposed = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;

    const onResize = () => {
      if (fit) {
        try { fit.fit(); } catch { /* 尺寸未就绪忽略 */ }
      }
    };
    window.addEventListener("resize", onResize);

    getAuthToken()
      .then((token) => {
        if (disposed) return;
        openTimer = setTimeout(() => {
          if (disposed) return;
          const t = new Terminal({
            cursorBlink: true,
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            theme: {
              background: "#0b1220",
              foreground: "#cfe0f5",
              cursor: "#9fb6d6",
              selectionBackground: "#2b3f5e",
            },
            convertEol: true,
          });
          const f = new FitAddon();
          t.loadAddon(f);
          term = t;
          fit = f;

          if (elRef.current) {
            t.open(elRef.current);
            // 元素此时已有确定尺寸（父容器 h-[72vh] / h-full），首帧 fit 建立列行数
            try { f.fit(); } catch { /* 渲染器尺寸尚未就绪，待 ws.onopen 再 fit */ }
          }

          const proto = location.protocol === "https:" ? "wss" : "ws";
          const qs = new URLSearchParams({ cluster, ns, pod, container, command, token });
          ws = new WebSocket(`${proto}://${location.host}/api/pod-exec?${qs.toString()}`);
          ws.binaryType = "arraybuffer";

          ws.onopen = () => {
            t.write("\x1b[36m已连接到容器控制台（输入 exit 退出）\x1b[0m\r\n");
            // 连接建立后再做一次 fit：此时 ws 已 OPEN，onResize 才会真正把尺寸发往后端的
            // TerminalSizeQueue（组件挂载时的首次 fit.fit() 因 ws 尚不存在而被丢弃）。
            try { f.fit(); } catch { /* 尺寸计算异常忽略 */ }
          };
          ws.onmessage = (e) => {
            if (typeof e.data === "string") {
              try {
                const m = JSON.parse(e.data);
                if (m.type === "resize") return;
              } catch {
                /* 非 JSON 文本直接输出 */
              }
              t.write(e.data);
            } else {
              t.write(new Uint8Array(e.data));
            }
          };
          ws.onclose = () => {
            if (!disposed) t.write("\r\n\x1b[31m[连接已关闭]\x1b[0m\r\n");
          };
          ws.onerror = () => {
            if (!disposed) t.write("\r\n\x1b[31m[连接错误]\x1b[0m\r\n");
          };

          t.onData((d) => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
          });
          t.onResize(({ cols, rows }) => {
            // 过滤掉首次 fit 可能产生的 0 尺寸，避免把 pty 尺寸置为 0 导致渲染异常。
            if (ws && ws.readyState === WebSocket.OPEN && cols > 0 && rows > 0) {
              ws.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          });
        }, 0);
      })
      .catch((e) => {
        const msg = `\r\n\x1b[31m获取令牌失败: ${(e as Error).message}\x1b[0m\r\n`;
        if (elRef.current && !term) elRef.current.textContent = msg;
      });

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      if (openTimer) clearTimeout(openTimer);
      if (ws) {
        try { ws.close(); } catch { /* noop */ }
      }
      if (term) term.dispose();
    };
  }, [cluster, ns, pod, container, command]);

  return <div ref={elRef} className="h-full rounded-lg overflow-hidden border border-line bg-[#0b1220]" />;
}
