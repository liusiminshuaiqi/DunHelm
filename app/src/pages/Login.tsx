import { useState } from "react";
import { login, type AuthUser } from "@/lib/api";
import { ShieldCheck, KeyRound, Loader2 } from "lucide-react";

export function Login({ onLoggedIn }: { onLoggedIn?: (u: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setLoading(true);
    try {
      const u = await login(username.trim(), password);
      onLoggedIn?.(u);
    } catch (err: any) {
      setError(err?.message || "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[radial-gradient(120%_120%_at_50%_0%,#0B4F9E_0%,#0A2E66_45%,#061C42_100%)] relative overflow-hidden">
      {/* 装饰光斑 */}
      <div className="absolute -top-32 -left-24 w-96 h-96 rounded-full bg-cyan-400/20 blur-3xl" />
      <div className="absolute -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-brand-500/20 blur-3xl" />

      <form
        onSubmit={submit}
        className="relative z-10 w-[380px] max-w-[92vw] rounded-2xl border border-white/10 bg-white/95 shadow-2xl p-8 space-y-6 backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white shadow-lg">
            <ShieldCheck size={22} />
          </div>
          <div>
            <div className="text-[19px] font-semibold text-ink-900 tracking-tight">DunHelm</div>
            <div className="text-[11px] text-ink-400">容器云管理平台 · 登录</div>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium text-ink-600">用户名 / 邮箱</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder="请输入账号"
              className="mt-1 w-full h-10 px-3 rounded-lg border border-line bg-surface text-[13px] text-ink-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition"
            />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-ink-600">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="请输入密码"
              className="mt-1 w-full h-10 px-3 rounded-lg border border-line bg-surface text-[13px] text-ink-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 transition"
            />
          </label>
        </div>

        {error && (
          <div className="text-[12px] text-err bg-err/10 border border-err/30 rounded-lg px-3 py-2">{error}</div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full h-10 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[13px] font-medium shadow-[0_4px_14px_-3px_rgba(19,96,196,.5)] hover:opacity-95 disabled:opacity-60 transition flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 size={15} className="animate-spin" /> 登录中…
            </>
          ) : (
            <>
              <KeyRound size={15} /> 登录
            </>
          )}
        </button>
      </form>
    </div>
  );
}
