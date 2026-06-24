'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserCog, Save, AlertCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, TEAMS, type Team } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';

const LAB_ROLES = ['lab_manager', 'assistant', 'chef'] as const;
const EDITABLE_ROLES = LAB_ROLES; // admins are shown read-only

type UserRow = {
  id: string;
  full_name: string;
  role: string;
  lab_profiles: { team: string | null } | null;
};

export default function UsersView({ users }: { users: UserRow[] }) {
  const { lang } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<Record<string, { role: string; team: string | null }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function getEdit(user: UserRow) {
    return editing[user.id] ?? {
      role: user.role,
      team: user.lab_profiles?.team ?? null,
    };
  }

  function updateEdit(userId: string, patch: Partial<{ role: string; team: string | null }>) {
    setEditing(prev => ({
      ...prev,
      [userId]: { ...getEdit(users.find(u => u.id === userId)!), ...patch },
    }));
  }

  async function save(user: UserRow) {
    const edit = getEdit(user);
    setSaving(user.id);
    setError(null);
    const supabase = createClient();

    const { error: roleErr } = await supabase
      .from('profiles')
      .update({ role: edit.role })
      .eq('id', user.id);

    if (roleErr) { setError(roleErr.message); setSaving(null); return; }

    // Manage lab_profiles
    const isLabRole = LAB_ROLES.includes(edit.role as any);
    if (isLabRole) {
      const { error: lpErr } = await supabase
        .from('lab_profiles')
        .upsert({ id: user.id, team: edit.team }, { onConflict: 'id' });
      if (lpErr) { setError(lpErr.message); setSaving(null); return; }
    } else {
      // Remove lab_profile if not a lab role
      await supabase.from('lab_profiles').delete().eq('id', user.id);
    }

    setSaving(null);
    // Clear local edit state
    setEditing(prev => { const n = { ...prev }; delete n[user.id]; return n; });
    router.refresh();
  }

  const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin', sales: 'Sales', viewer: 'Viewer',
    lab_manager: 'Lab Manager', assistant: 'Assistant', chef: 'Chef',
  };

  const ROLE_BADGE: Record<string, string> = {
    admin: 'bg-navy text-white', sales: 'bg-gold/20 text-gold',
    viewer: 'bg-gray-100 text-gray-600', lab_manager: 'bg-purple-100 text-purple-700',
    assistant: 'bg-blue-100 text-blue-700', chef: 'bg-emerald-100 text-emerald-700',
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="font-serif text-3xl font-bold text-navy">{lang === 'vi' ? 'Quản lý người dùng' : 'User management'}</h1>
        <p className="text-sm text-ink-light mt-1">
          {lang === 'vi'
            ? 'Phân quyền và gán đội sản xuất cho từng người'
            : 'Assign roles and production teams to each user'}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="hidden md:grid grid-cols-12 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 border-b border-border-soft">
          <div className="col-span-4">{lang === 'vi' ? 'Người dùng' : 'User'}</div>
          <div className="col-span-3">{lang === 'vi' ? 'Vai trò' : 'Role'}</div>
          <div className="col-span-3">{lang === 'vi' ? 'Đội' : 'Team'}</div>
          <div className="col-span-2"></div>
        </div>

        <div className="divide-y divide-border-soft">
          {users.map(user => {
            const isAdmin = user.role === 'admin';
            const edit = getEdit(user);
            const isLabRole = LAB_ROLES.includes(edit.role as any);
            const isDirty = !isAdmin && (edit.role !== user.role || edit.team !== (user.lab_profiles?.team ?? null));
            const isChef = edit.role === 'chef';

            return (
              <div key={user.id} className="grid grid-cols-12 items-center px-4 py-3 gap-2">
                {/* Name */}
                <div className="col-span-12 md:col-span-4 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-navy/10 flex items-center justify-center shrink-0">
                    <UserCog size={14} className="text-navy" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-navy truncate">{user.full_name}</div>
                    <span className={`badge text-[10px] ${ROLE_BADGE[user.role] ?? 'bg-gray-100 text-gray-600'}`}>
                      {ROLE_LABEL[user.role] ?? user.role}
                    </span>
                  </div>
                </div>

                {/* Role select (read-only for admin) */}
                <div className="col-span-5 md:col-span-3">
                  {isAdmin ? (
                    <span className="text-xs text-ink-light italic">{lang === 'vi' ? 'Không thể thay đổi' : 'Cannot change'}</span>
                  ) : (
                    <select
                      value={edit.role}
                      onChange={e => updateEdit(user.id, { role: e.target.value, team: null })}
                      className="input text-sm w-full"
                    >
                      {EDITABLE_ROLES.map(r => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Team select */}
                <div className="col-span-4 md:col-span-3">
                  {!isAdmin && isLabRole ? (
                    <select
                      value={edit.team ?? ''}
                      onChange={e => updateEdit(user.id, { team: e.target.value || null })}
                      className="input text-sm w-full"
                      disabled={!isChef}
                    >
                      {!isChef && <option value="">— {lang === 'vi' ? 'Tất cả' : 'All teams'} —</option>}
                      {isChef && <option value="">{lang === 'vi' ? 'Chọn đội…' : 'Select team…'}</option>}
                      {TEAMS.map(team => (
                        <option key={team} value={team}>
                          {lang === 'vi' ? TEAM_LABELS[team as Team].vi : TEAM_LABELS[team as Team].en}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-ink-light">—</span>
                  )}
                </div>

                {/* Save button */}
                <div className="col-span-3 md:col-span-2 flex justify-end">
                  {isDirty && (
                    <button
                      onClick={() => save(user)}
                      disabled={saving === user.id || (isChef && !edit.team)}
                      className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                    >
                      <Save size={12} />
                      {saving === user.id ? '…' : (lang === 'vi' ? 'Lưu' : 'Save')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Role legend */}
      <div className="card p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-light mb-3">
          {lang === 'vi' ? 'Quyền hạn' : 'Permissions'}
        </h3>
        <div className="space-y-1.5 text-xs text-ink">
          {[
            { role: 'lab_manager', en: 'Full access: import, review, publish, manage users', vi: 'Toàn quyền: nhập, xem xét, phát hành, quản lý người dùng' },
            { role: 'assistant', en: 'Import and review orders, mark exceptions', vi: 'Nhập và xem xét đơn, đánh dấu ngoại lệ' },
            { role: 'chef', en: "View own team's station only, update progress", vi: 'Chỉ xem trạm đội mình, cập nhật tiến độ' },
          ].map(({ role, en, vi }) => (
            <div key={role} className="flex items-start gap-2">
              <span className={`badge text-[10px] shrink-0 mt-0.5 ${ROLE_BADGE[role]}`}>{ROLE_LABEL[role]}</span>
              <span>{lang === 'vi' ? vi : en}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
