import { Component, type ReactNode } from "react";

interface State { error: Error | null }

// 顶层错误边界：任何子组件渲染抛错都不会再导致整页白屏，
// 而是展示可读的错误卡片 + 重新加载按钮，并保留具体错误信息便于排查。
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // 同时打到控制台，方便开发者工具定位
    console.error("[DunHelm] 渲染崩溃:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen w-full grid place-items-center bg-app px-6">
          <div className="card-beam relative w-full max-w-lg rounded-xl border border-line bg-surface shadow-sh-3 p-6">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center">
                <span className="text-white text-[15px] font-bold">!</span>
              </div>
              <h1 className="text-[15px] font-semibold text-ink-900">页面渲染出错</h1>
            </div>
            <p className="text-[12.5px] text-ink-500 mb-3">
              界面遇到了意外错误。通常是热更新（HMR）状态残留导致，刷新即可恢复；若反复出现请把下方错误信息发我。
            </p>
            <pre className="w-full max-h-48 overflow-auto rounded-lg bg-sunken border border-line p-3 text-[11.5px] font-mono text-err leading-relaxed whitespace-pre-wrap break-words">
{this.state.error.message}
{"\n"}
{(this.state.error.stack || "").split("\n").slice(0, 6).join("\n")}
            </pre>
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition"
              >
                重新加载
              </button>
              <button
                onClick={() => this.setState({ error: null })}
                className="inline-flex items-center justify-center h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition"
              >
                尝试继续
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
