import { useEffect, useState } from "react";
import {
  Card, CardHead, SectionTitle, TextArea,
} from "@/components/ui/primitives";
import { getMavenSettings, saveMavenSettings } from "@/lib/api";
import { useCluster } from "@/data/useLive";
import { Check, Loader2, UploadCloud, RotateCcw } from "lucide-react";

// 集群级 Maven 全局配置页（「平台治理 → 构建配置」）。
// 内容 = settings.xml 全文，仅放 mirror / proxy 这类「无密钥」的公共配置；
// 含 servers 凭证的敏感配置请走每条流水线各自的「Maven 构建配置」。
// 配置按集群隔离：每个集群各自的 Maven 全局设置，切换集群会重新加载本集群的配置；
// 保存后引擎在「该集群」的构建 Pod 内挂该文件到 /opt/dunhelm/maven-global-settings.xml，
// 并对含 mvn 的命令自动注入 -gs 让其生效（各 maven 镜像 MAVEN_HOME 路径不一，无法统一覆盖 conf/settings.xml）。
export function BuildConfig() {
  const cluster = useCluster();
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMsg(null);
    getMavenSettings()
      .then((d) => {
        if (!alive) return;
        setContent(d.content || "");
        setLoaded(d.content || "");
      })
      .catch((e) => {
        if (!alive) return;
        setMsg({ kind: "err", text: (e as Error).message });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [cluster]);

  const dirty = content !== loaded;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await saveMavenSettings(content);
      setLoaded(content);
      setMsg({ kind: "ok", text: "已保存，将对后续所有构建生效" });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="top-aura relative p-5 space-y-4 max-w-[960px]">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[15px] font-semibold text-ink-900 leading-none">构建配置 · Maven 全局设置</h3>
          <p className="text-[11.5px] text-ink-400 mt-1.5">
            集群级公共配置，随当前集群切换。每个集群独立配置，仅建议放 <span className="font-mono text-brand-700">mirror</span> / <span className="font-mono text-brand-700">proxy</span> 等无密钥内容；
            含账号密码的 <span className="font-mono text-brand-700">&lt;servers&gt;</span> 请在各流水线「基本信息 → Maven 构建配置」单独填写。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setContent(loaded)}
            disabled={!dirty || saving}
            className="h-8 px-3 rounded-md border border-line bg-surface text-[12px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1 disabled:opacity-40"
          >
            <RotateCcw size={12} /> 还原
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="h-8 px-3.5 rounded-md bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <Card>
        <CardHead
          title="settings.xml（全局）"
          sub="挂载路径 /opt/dunhelm/maven-global-settings.xml · 引擎对 mvn 命令自动注入 -gs"
          right={
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
                  reader.onload = () => setContent(String(reader.result || ""));
                  reader.readAsText(f);
                  e.target.value = "";
                }}
              />
            </label>
          }
        />
        <div className="p-3">
          {loading ? (
            <div className="h-40 grid place-items-center text-ink-400 text-[12px]">
              <Loader2 size={16} className="animate-spin" /> 加载中…
            </div>
          ) : (
            <TextArea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={18}
              className="font-mono text-[11.5px] leading-relaxed resize-y bg-surface"
              placeholder={'<settings>\n  <mirrors>\n    <mirror>\n      <id>aliyun</id>\n      <name>Aliyun Maven</name>\n      <url>https://maven.aliyun.com/repository/public</url>\n      <mirrorOf>*</mirrorOf>\n    </mirror>\n  </mirrors>\n  <proxies>\n    <proxy>\n      <id>corp-proxy</id>\n      <host>proxy.corp.local</host>\n      <port>8080</port>\n    </proxy>\n  </proxies>\n</settings>'}
            />
          )}
          {msg && (
            <div className={`mt-2 px-3 py-1.5 text-[11.5px] rounded-md border ${
              msg.kind === "ok"
                ? "border-ok/40 bg-ok-bg text-ok"
                : "border-err/40 bg-err-bg text-err"
            }`}>
              {msg.text}
            </div>
          )}
        </div>
      </Card>

      <SectionTitle title="生效说明" desc="构建引擎如何消费这份配置" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="!p-3.5">
          <div className="text-[12px] font-semibold text-ink-900 mb-1">1 · 写入 ConfigMap</div>
          <p className="text-[11px] text-ink-500 leading-relaxed">
            保存后写入固定 ConfigMap <span className="font-mono text-brand-700">dunhelm-ci-maven-global</span>（命名空间 dunhelm-ci），<span className="text-brand-700">当前集群</span>所有构建 Pod 共享挂载。
          </p>
        </Card>
        <Card className="!p-3.5">
          <div className="text-[12px] font-semibold text-ink-900 mb-1">2 · 挂载到构建 Pod</div>
          <p className="text-[11px] text-ink-500 leading-relaxed">
            挂载到 <span className="font-mono text-brand-700">/opt/dunhelm/maven-global-settings.xml</span>。仅作用于<span className="text-brand-700">当前集群</span>的构建 Pod，路径固定避免各 maven 镜像 MAVEN_HOME 不一致导致覆盖失败。
          </p>
        </Card>
        <Card className="!p-3.5">
          <div className="text-[12px] font-semibold text-ink-900 mb-1">3 · 命令注入 -gs</div>
          <p className="text-[11px] text-ink-500 leading-relaxed">
            阶段命令含 <span className="font-mono text-brand-700">mvn</span> 时，引擎自动用 shell 函数包裹注入 <span className="font-mono text-brand-700">-gs</span>，使其读取本全局配置。
          </p>
        </Card>
      </div>
    </div>
  );
}
