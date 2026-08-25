import { useEffect, useState } from "react";
import { Card, CardHead, KpiStat, StatusBadge, Modal, Field, TextInput, SelectInput, PrimaryButton } from "@/components/ui/primitives";
import { useUsers, useRoles } from "@/data/useLive";
import { useClusters } from "@/data/useLive";
import { cn } from "@/lib/utils";
import {
  inviteUser, updateUser, deleteUser, setUserActive, resetUserPassword,
  listUserPermissions, assignUserPermission, revokeUserPermission,
  createRole, deleteRole, roleMenus, setRoleMenus,
  ALL_MENU_KEYS, MENU_LABEL, MENU_GROUP,
  type UserRow, type RoleRow, type UserClusterPermissionRow,
} from "@/lib/api";
import { Users as UsersIcon, ShieldCheck, UserPlus, KeyRound, Pencil, Trash2, Power, Lock, Unlock, Plus, Shield, Grid3x3, ListChecks } from "lucide-react";

type Tab = "members" | "roles" | "matrix";

// 角色 → 中文显示名映射（slug → 名称）
const roleSlugToName: Record<string, string> = {
  "platform-admin": "平台管理员",
  "workspace-admin": "空间管理员",
  "developer": "开发者",
  "viewer": "访客",
};
const roleSlugToColor: Record<string, string> = {
  "platform-admin": "text-brand-600 bg-brand-50 border-brand-200",
  "workspace-admin": "text-cyan-700 bg-cyan-50 border-cyan-200",
  "developer": "text-ok bg-ok-bg border-ok/30",
  "viewer": "text-idle bg-idle-bg border-idle/30",
};

export function Users() {
  const [tab, setTab] = useState<Tab>("members");

  return (
    <div className="top-aura relative p-5 space-y-4">
      {/* Tab 切换栏 */}
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-1 w-fit">
        <TabButton active={tab === "members"} onClick={() => setTab("members")} icon={<UsersIcon size={14} />}>成员</TabButton>
        <TabButton active={tab === "roles"} onClick={() => setTab("roles")} icon={<Shield size={14} />}>角色定义</TabButton>
        <TabButton active={tab === "matrix"} onClick={() => setTab("matrix")} icon={<Grid3x3 size={14} />}>权限矩阵</TabButton>
      </div>

      {tab === "members" && <MembersTab />}
      {tab === "roles" && <RolesTab />}
      {tab === "matrix" && <MatrixTab />}
    </div>
  );
}

function TabButton({ active, onClick, children, icon }: { active: boolean; onClick: () => void; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-8 px-3 rounded-md text-[12px] font-medium flex items-center gap-1.5 transition",
        active ? "bg-brand-600 text-white shadow-sh-1" : "text-ink-600 hover:bg-subtle",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ============ 成员 Tab ============
function MembersTab() {
  const { data: users, reload } = useUsers();
  const { data: roles } = useRoles();
  const total = users.length;
  const active = users.filter((u) => u.active !== false && u.status === "ok").length;
  const locked = users.filter((u) => u.status === "locked" || u.active === false).length;
  const roleCount = roles.length;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);

  return (
    <>
      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rise-1"><KpiStat label="用户总数" value={total} unit="人" icon={<UsersIcon size={18} />} accent="brand" /></div>
        <div className="rise-2"><KpiStat label="活跃用户" value={active} unit="人" icon={<ShieldCheck size={18} />} accent="ok" /></div>
        <div className="rise-3"><KpiStat label="已禁用" value={locked} unit="人" icon={<Lock size={18} />} accent="warn" /></div>
        <div className="rise-4"><KpiStat label="角色定义" value={roleCount} unit="种" icon={<KeyRound size={18} />} accent="cyan" /></div>
      </div>

      <Card className="rise-3">
        <CardHead title="用户与角色" sub={`${users.length} 位成员 · RBAC 授权`} right={
          <PrimaryButton icon={<UserPlus size={15} />} onClick={() => setInviteOpen(true)}>邀请用户</PrimaryButton>
        } />
        <div className="px-2 pb-2 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-ink-400 text-[11px] font-medium">
                <th className="text-left font-medium px-3 py-2">用户</th>
                <th className="text-left font-medium px-3 py-2">角色</th>
                <th className="text-left font-medium px-3 py-2">邮箱</th>
                <th className="text-left font-medium px-3 py-2">状态</th>
                <th className="text-left font-medium px-3 py-2">活跃</th>
                <th className="text-left font-medium px-3 py-2">最后登录</th>
                <th className="text-right font-medium px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-ink-400 text-[12px]">暂无用户，点击右上角邀请</td>
                </tr>
              )}
              {users.map((u) => (
                <tr key={u.id} className="border-t border-line hover:bg-subtle transition">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[11px] font-bold flex-none">
                        {u.name.slice(0, 1)}
                      </div>
                      <span className="text-ink-900 font-medium">{u.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn(
                      "text-[11px] rounded px-1.5 py-0.5 border",
                      roleSlugToColor[u.role] || "text-ink-600 bg-subtle border-line",
                    )}>{roleSlugToName[u.role] || u.role}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-500">{u.email}</td>
                  <td className="px-3 py-2"><StatusBadge kind={u.status === "ok" ? "ok" : u.status === "locked" ? "err" : u.status === "pending" ? "warn" : "idle"} /></td>
                  <td className="px-3 py-2">
                    {u.active === false ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-err/10 text-err border border-err/30">已禁用</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-ok/10 text-ok border border-ok/30">启用</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-400">{u.lastLogin || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <IconBtn title="编辑" onClick={() => setEditTarget(u)}>
                        <Pencil size={11} />
                      </IconBtn>
                      <IconBtn
                        title={u.active === false ? "启用" : "禁用"}
                        onClick={async () => {
                          try {
                            await setUserActive(u.id, u.active === false);
                            reload();
                          } catch (e) { console.error(e); }
                        }}
                      >
                        {u.active === false ? <Unlock size={11} /> : <Lock size={11} />}
                      </IconBtn>
                      <IconBtn
                        title="删除"
                        onClick={async () => {
                          if (!confirm(`确定删除用户「${u.name}」及其全部集群权限？`)) return;
                          try {
                            await deleteUser(u.id);
                            reload();
                          } catch (e) { console.error(e); }
                        }}
                      >
                        <Trash2 size={11} />
                      </IconBtn>
                      <IconBtn
                        title="重置密码"
                        onClick={() => setResetTarget(u)}
                      >
                        <KeyRound size={11} />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 邀请用户 */}
      <InviteUserModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        roles={roles}
        onCreated={() => { reload(); setInviteOpen(false); }}
      />

      {/* 编辑用户 */}
      <EditUserModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        roles={roles}
        onSaved={() => { reload(); setEditTarget(null); }}
      />

      {/* 重置密码 */}
      <ResetPasswordModal
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        onSaved={() => { reload(); setResetTarget(null); }}
      />
    </>
  );
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="h-7 w-7 grid place-items-center rounded-md border border-line bg-surface text-ink-500 hover:border-brand-300 hover:text-brand-700 transition"
    >
      {children}
    </button>
  );
}

function InviteUserModal({ open, onClose, roles, onCreated }: { open: boolean; onClose: () => void; roles: RoleRow[]; onCreated: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", role: "viewer", password: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="邀请用户"
      desc="邀请新成员并分配平台默认角色"
      icon={<UserPlus size={15} />}
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          <button onClick={async () => {
            if (!form.name || !form.email) return;
            try {
              await inviteUser({ name: form.name, email: form.email, role: form.role, password: form.password || undefined });
              setForm({ name: "", email: "", role: "viewer", password: "" });
              onCreated();
            } catch (e) { console.error(e); }
          }} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">发送邀请</button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="用户名"><TextInput value={form.name} onChange={set("name")} placeholder="李四" /></Field>
        <Field label="邮箱"><TextInput value={form.email} onChange={set("email")} placeholder="name@dunhelm.io" /></Field>
        <Field label="平台默认角色" className="col-span-2">
          <SelectInput value={form.role} onChange={set("role")}>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>{r.name}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="初始密码（可选）" className="col-span-2">
          <TextInput type="password" value={form.password} onChange={set("password")} placeholder="留空则使用默认密码 DunHelm@2026" />
        </Field>
      </div>
    </Modal>
  );
}

function EditUserModal({ target, onClose, roles, onSaved }: { target: UserRow | null; onClose: () => void; roles: RoleRow[]; onSaved: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", role: "viewer", password: "" });
  useEffect(() => {
    if (target) {
      setForm({ name: target.name, email: target.email, role: target.role, password: "" });
    }
  }, [target]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  if (!target) return null;
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`编辑用户：${target.name}`}
      desc="修改基本信息与平台默认角色"
      icon={<Pencil size={15} />}
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          <button onClick={async () => {
            try {
              const body: { name: string; email: string; role: string; password?: string } = {
                name: form.name, email: form.email, role: form.role,
              };
              if (form.password) body.password = form.password;
              await updateUser(target.id, body);
              onSaved();
            } catch (e) { console.error(e); }
          }} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">保存</button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="用户名"><TextInput value={form.name} onChange={set("name")} /></Field>
        <Field label="邮箱"><TextInput value={form.email} onChange={set("email")} /></Field>
        <Field label="平台默认角色" className="col-span-2">
          <SelectInput value={form.role} onChange={set("role")}>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>{r.name}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="重置密码（可选）" className="col-span-2">
          <TextInput type="password" value={form.password} onChange={set("password")} placeholder="留空则不修改密码" />
        </Field>
      </div>
    </Modal>
  );
}

// 管理员重置某用户密码（不回显明文）
function ResetPasswordModal({ target, onClose, onSaved }: { target: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const [pw, setPw] = useState("");
  const [loading, setLoading] = useState(false);
  if (!target) return null;
  const submit = async () => {
    setLoading(true);
    try {
      await resetUserPassword(target.id, pw || undefined);
      onSaved();
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`重置密码：${target.name}`}
      desc="设置新密码；留空则回退到平台默认初始密码"
      icon={<KeyRound size={15} />}
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          <button
            onClick={submit}
            disabled={loading}
            className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-60"
          >
            {loading ? "重置中…" : "确认重置"}
          </button>
        </>
      }
    >
      <Field label="新密码">
        <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="留空 = 默认密码 DunHelm@2026" />
      </Field>
    </Modal>
  );
}

// ============ 角色定义 Tab ============
function RolesTab() {
  const { data: roles, reload } = useRoles();
  const [createOpen, setCreateOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<RoleRow | null>(null);

  return (
    <Card className="rise-3">
      <CardHead title="角色定义" sub="4 个系统内置角色 + 自定义角色 · 菜单权限可编辑" right={
        <PrimaryButton icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>新建角色</PrimaryButton>
      } />
      <div className="px-2 pb-2 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-ink-400 text-[11px] font-medium">
              <th className="text-left font-medium px-3 py-2">角色</th>
              <th className="text-left font-medium px-3 py-2">标识 (slug)</th>
              <th className="text-left font-medium px-3 py-2">说明</th>
              <th className="text-left font-medium px-3 py-2">类型</th>
              <th className="text-right font-medium px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-400 text-[12px]">暂无角色</td></tr>
            )}
            {roles.map((r) => (
              <tr key={r.slug} className="border-t border-line hover:bg-subtle transition">
                <td className="px-3 py-2">
                  <span className={cn(
                    "text-[11px] rounded px-1.5 py-0.5 border font-medium",
                    roleSlugToColor[r.slug] || "text-ink-600 bg-subtle border-line",
                  )}>{r.name}</span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-ink-600">{r.slug}</td>
                <td className="px-3 py-2 text-ink-700 text-[11.5px]">{r.description}</td>
                <td className="px-3 py-2">
                  {r.isSystem ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200">系统内置</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">自定义</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <IconBtn title="菜单权限" onClick={() => setMenuTarget(r)}>
                      <ListChecks size={11} />
                    </IconBtn>
                    {!r.isSystem && (
                      <IconBtn title="删除" onClick={async () => {
                        if (!confirm(`确定删除自定义角色「${r.name}」？`)) return;
                        try { await deleteRole(r.slug); reload(); } catch (e) { console.error(e); }
                      }}>
                        <Trash2 size={11} />
                      </IconBtn>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateRoleModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { reload(); setCreateOpen(false); }} />
      {menuTarget && (
        <RoleMenuPermissionEditor
          role={menuTarget}
          onClose={() => setMenuTarget(null)}
          onSaved={() => { reload(); setMenuTarget(null); }}
        />
      )}
    </Card>
  );
}

// 角色菜单权限编辑器（侧弹抽屉）
function RoleMenuPermissionEditor({ role, onClose, onSaved }: { role: RoleRow; onClose: () => void; onSaved: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    if (role.slug === "platform-admin") {
      setChecked(new Set(ALL_MENU_KEYS));
      setLoading(false);
      return;
    }
    roleMenus(role.slug)
      .then((menus) => { if (alive) { setChecked(new Set(menus)); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [role.slug]);

  // 按分组组织菜单
  const grouped: Record<string, string[]> = {};
  for (const m of ALL_MENU_KEYS) {
    const g = MENU_GROUP[m] ?? "其他";
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(m);
  }
  const groupOrder = ["概览", "资源", "DevOps", "平台治理"];

  const toggleMenu = (k: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const toggleGroup = (g: string) => {
    const items = grouped[g] || [];
    const allChecked = items.every((k) => checked.has(k));
    setChecked((prev) => {
      const next = new Set(prev);
      for (const k of items) {
        if (allChecked) next.delete(k); else next.add(k);
      }
      return next;
    });
  };

  const save = async () => {
    if (role.slug === "platform-admin") {
      onSaved();
      return;
    }
    setSubmitting(true);
    try {
      await setRoleMenus(role.slug, Array.from(checked));
      onSaved();
    } catch (e) { console.error(e); setSubmitting(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`菜单权限：${role.name}`}
      desc={role.slug === "platform-admin" ? "平台管理员始终拥有所有菜单权限，不可修改" : `标识 ${role.slug} · 勾选该角色可见的菜单`}
      icon={<ListChecks size={15} />}
      maxW="max-w-lg"
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          {role.slug !== "platform-admin" && (
            <button onClick={save} disabled={submitting || loading} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50">
              {submitting ? "保存中…" : `保存（${checked.size} 项）`}
            </button>
          )}
        </>
      }
    >
      {loading ? (
        <div className="py-4 text-center text-[12px] text-ink-400">加载中…</div>
      ) : (
        <div className="space-y-3">
          {groupOrder.filter((g) => grouped[g]).map((g) => {
            const items = grouped[g];
            const checkedCount = items.filter((k) => checked.has(k)).length;
            return (
              <div key={g} className="rounded-lg border border-line bg-surface overflow-hidden">
                <button
                  onClick={() => role.slug !== "platform-admin" && toggleGroup(g)}
                  disabled={role.slug === "platform-admin"}
                  className="w-full px-3 py-2 flex items-center gap-2 text-left bg-subtle/50 hover:bg-subtle transition border-b border-line disabled:cursor-not-allowed"
                >
                  <span className="text-[12.5px] font-semibold text-ink-900">{g}</span>
                  <span className="text-[10px] text-ink-400 font-mono">{checkedCount}/{items.length}</span>
                  <span className="ml-auto text-[10px] text-ink-400">{checkedCount === items.length ? "全选" : checkedCount === 0 ? "全不选" : "部分"}</span>
                </button>
                <div className="p-2 grid grid-cols-2 gap-1">
                  {items.map((k) => (
                    <label key={k} className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] cursor-pointer transition",
                      checked.has(k) ? "bg-brand-50 text-brand-700" : "hover:bg-sunken text-ink-700",
                    )}>
                      <input
                        type="checkbox"
                        checked={checked.has(k)}
                        onChange={() => toggleMenu(k)}
                        disabled={role.slug === "platform-admin"}
                        className="w-3.5 h-3.5 accent-brand-600"
                      />
                      <span className="truncate">{MENU_LABEL[k] ?? k}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function CreateRoleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ slug: "", name: "", description: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建角色"
      desc="自定义角色用于更细粒度的权限控制"
      icon={<Plus size={15} />}
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          <button onClick={async () => {
            if (!form.slug || !form.name) return;
            try {
              await createRole({ slug: form.slug, name: form.name, description: form.description });
              setForm({ slug: "", name: "", description: "" });
              onCreated();
            } catch (e) { console.error(e); }
          }} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition">创建</button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="角色名"><TextInput value={form.name} onChange={set("name")} placeholder="运维" /></Field>
        <Field label="标识 (slug)"><TextInput value={form.slug} onChange={set("slug")} placeholder="ops" /></Field>
        <Field label="说明" className="col-span-2"><TextInput value={form.description} onChange={set("description")} placeholder="日常运维与监控" /></Field>
      </div>
    </Modal>
  );
}

// ============ 权限矩阵 Tab ============
function MatrixTab() {
  const { data: users } = useUsers();
  const { data: clusters } = useClusters();
  const { data: roles } = useRoles();
  const [tick, setTick] = useState(0);
  // 用户 × 集群 的权限矩阵
  const [matrix, setMatrix] = useState<Record<number, UserClusterPermissionRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [permTarget, setPermTarget] = useState<{ userId: number; clusterId: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all(users.map((u) => listUserPermissions(u.id).then((p) => [u.id, p] as const)))
      .then((arr) => {
        if (!alive) return;
        const m: Record<number, UserClusterPermissionRow[]> = {};
        arr.forEach(([uid, p]) => { m[uid] = p; });
        setMatrix(m);
        setLoading(false);
      })
      .catch((e) => { console.error(e); if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [users, tick]);

  const userByid = (id: number) => users.find((u) => u.id === id);

  return (
    <Card className="rise-3">
      <CardHead
        title="权限矩阵"
        sub="用户 × 集群 授权可视化，点击单元格分配或撤销权限"
        right={
          <button onClick={() => setTick((t) => t + 1)} className="h-8 px-2.5 rounded-md border border-line bg-surface text-[11.5px] text-ink-700 hover:border-brand-300 hover:text-brand-700 transition flex items-center gap-1">
            <Power size={11} /> 刷新
          </button>
        }
      />
      <div className="px-2 pb-2 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-ink-400 text-[11px] font-medium">
              <th className="text-left font-medium px-3 py-2 sticky left-0 bg-surface z-10 min-w-[140px]">用户 / 集群</th>
              {clusters.map((cl) => (
                <th key={cl.id} className="text-center font-medium px-3 py-2 min-w-[110px]">
                  <div className="font-mono text-[11px] text-ink-700">{cl.name}</div>
                  <div className="text-[9.5px] text-ink-400">id={cl.id}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-line hover:bg-subtle/50 transition">
                <td className="px-3 py-2 sticky left-0 bg-surface z-10">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-600 to-cyan-500 grid place-items-center text-white text-[10px] font-bold flex-none">
                      {u.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <div className="text-ink-900 font-medium text-[11.5px] truncate">{u.name}</div>
                      <div className="text-[10px] text-ink-400 truncate">{roleSlugToName[u.role] || u.role}</div>
                    </div>
                  </div>
                </td>
                {clusters.map((cl) => {
                  const perm = (matrix[u.id] || []).find((p) => p.clusterId === cl.id);
                  return (
                    <td key={cl.id} className="px-2 py-2 text-center">
                      <button
                        onClick={() => setPermTarget({ userId: u.id, clusterId: cl.id })}
                        className={cn(
                          "w-full h-9 rounded-md border text-[11px] font-medium transition flex items-center justify-center gap-1",
                          perm
                            ? [roleSlugToColor[perm.roleSlug] || "text-ink-600 bg-subtle border-line", "hover:opacity-90"]
                            : "border-dashed border-line text-ink-400 hover:border-brand-300 hover:text-brand-700",
                        )}
                        title={perm ? `${roleSlugToName[perm.roleSlug] || perm.roleSlug} · 点击修改` : "点击分配权限"}
                      >
                        {perm ? (
                          <>
                            <Shield size={10} />
                            <span>{roleSlugToName[perm.roleSlug] || perm.roleSlug}</span>
                          </>
                        ) : (
                          <>
                            <Plus size={10} /> 分配
                          </>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={clusters.length + 1} className="px-3 py-8 text-center text-ink-400 text-[12px]">暂无用户</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {permTarget && (
        <PermissionDrawer
          userId={permTarget.userId}
          clusterId={permTarget.clusterId}
          userName={userByid(permTarget.userId)?.name || "?"}
          clusterName={clusters.find((c) => c.id === permTarget.clusterId)?.name || "?"}
          currentPerm={(matrix[permTarget.userId] || []).find((p) => p.clusterId === permTarget.clusterId) || null}
          roles={roles}
          onClose={() => setPermTarget(null)}
          onSaved={() => { setTick((t) => t + 1); setPermTarget(null); }}
        />
      )}
    </Card>
  );
}

function PermissionDrawer({
  userId, clusterId, userName, clusterName, currentPerm, roles, onClose, onSaved,
}: {
  userId: number; clusterId: number; userName: string; clusterName: string;
  currentPerm: UserClusterPermissionRow | null; roles: RoleRow[];
  onClose: () => void; onSaved: () => void;
}) {
  const [roleSlug, setRoleSlug] = useState(currentPerm?.roleSlug || "viewer");
  const [submitting, setSubmitting] = useState(false);

  const save = async () => {
    setSubmitting(true);
    try {
      await assignUserPermission(userId, { clusterId, roleSlug, namespaces: [] });
      onSaved();
    } catch (e) { console.error(e); setSubmitting(false); }
  };

  const revoke = async () => {
    if (!confirm(`撤销「${userName}」对集群「${clusterName}」的权限？`)) return;
    try {
      await revokeUserPermission(userId, clusterId);
      onSaved();
    } catch (e) { console.error(e); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${userName} @ ${clusterName}`}
      desc={currentPerm ? `当前权限：${roleSlugToName[currentPerm.roleSlug] || currentPerm.roleSlug}` : "当前未分配权限"}
      icon={<Shield size={15} />}
      maxW="max-w-md"
      footer={
        <>
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-line bg-surface text-[12.5px] text-ink-700 hover:bg-sunken transition">取消</button>
          {currentPerm && (
            <button onClick={revoke} className="h-9 px-3 rounded-lg border border-err/30 bg-err/5 text-err text-[12.5px] hover:bg-err/10 transition">撤销权限</button>
          )}
          <button onClick={save} disabled={submitting} className="h-9 px-3.5 rounded-lg bg-gradient-to-r from-brand-600 to-cyan-500 text-white text-[12.5px] font-medium shadow-[0_3px_10px_-2px_rgba(19,96,196,.45)] hover:opacity-95 transition disabled:opacity-50">
            {submitting ? "保存中…" : "保存权限"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="对该集群授予角色">
          <SelectInput value={roleSlug} onChange={(e) => setRoleSlug(e.target.value)}>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>{r.name} · {r.description}</option>
            ))}
          </SelectInput>
        </Field>
        <div className="rounded-md bg-subtle border border-line p-2.5 text-[11px] text-ink-500 leading-relaxed">
          <p>提示：</p>
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            <li>平台管理员（platform-admin）自动拥有所有集群权限，无需分配</li>
            <li>命名空间范围（namespaces）为空时表示该集群全部 namespace 可见</li>
            <li>权限变更即时生效，下一次请求依据新权限判断</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}
