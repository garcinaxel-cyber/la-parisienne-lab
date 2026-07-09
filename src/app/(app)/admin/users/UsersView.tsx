'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserCog, Save, AlertCircle, UserPlus, X, KeyRound } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, TEAMS, type Team } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';
import { inviteLabUser, generateResetLink } from './actions';

const LAB_ROLES = ['lab_manager', 'assistant', 'chef', 'worker'] as const;
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
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState<string | null>(null);

  // Generate a password-reset link (no email sent — bypasses the rate limit)
  // and copy it so the admin can send it via Zalo.
  async function copyResetLink(userId: string) {
    setLinkFor(userId); setLinkCopied(null); setError(null);
    const { link, error: err } = await generateResetLink(userId);
    setLinkFor(null);
    if (err || !link) { setError(err ?? 'Failed'); return; }
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(userId);
      setTimeout(() => setLinkCopied(null), 3000);
    } catch {
      prompt(lang === 'vi' ? 'Sao chép liên kết:' : 'Copy this link:', link);
    }
  }

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState<{
    email: string; fullName: string;
    role: 'chef' | 'assistant' | 'lab_manager' | 'worker'; team: string;
  }>({ email: '', fullName: '', role: 'chef', team: '' });

  async function submitInvite() {
    if (!inviteForm.email || !inviteForm.fullName) return;
    if (['chef', 'worker'].includes(inviteForm.role) && !inviteForm.team) return;
    setInviting(true);
    setInviteError(null);
    const res = await inviteLabUser({
      email: inviteForm.email,
      fullName: inviteForm.fullName,
      role: inviteForm.role,
      team: ['chef', 'worker'].includes(inviteForm.role) ? inviteForm.team : null,
    });
    setInviting(false);
    if (res.error) { setInviteError(res.error); return; }
    setInviteSuccess(true);
    setInviteLink(res.link ?? null);
    router.refresh();
  }

  function resetInvite() {
    setShowInvite(false);
    setInviteSuccess(false);
    setInviteLink(null);
    setInviteLinkCopied(false);
    setInviteForm({ email: '', fullName: '', role: 'chef', team: '' });
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteLinkCopied(true);
      setTimeout(() => setInviteLinkCopied(false), 3000);
    } catch {
      prompt(lang === 'vi' ? 'Sao chép liên kết:' : 'Copy this link:', inviteLink);
    }
  }

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
    lab_manager: 'Lab Manager', assistant: 'Assistant', chef: 'Chef', worker: 'Worker',
  };

  const ROLE_BADGE: Record<string, string> = {
    admin: 'bg-navy text-white', sales: 'bg-gold/20 text-gold',
    viewer: 'bg-gray-100 text-gray-600', lab_manager: 'bg-purple-100 text-purple-700',
    assistant: 'bg-blue-100 text-blue-700', chef: 'bg-emerald-100 text-emerald-700',
    worker: 'bg-orange-100 text-orange-700',
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-bold text-navy">{lang === 'vi' ? 'Quản lý người dùng' : 'User management'}</h1>
          <p className="text-sm text-ink-light mt-1">
            {lang === 'vi'
              ? 'Phân quyền và gán đội sản xuất cho từng người'
              : 'Assign roles and production teams to each user'}
          </p>
        </div>
        <button
          onClick={() => { setShowInvite(true); setInviteError(null); setInviteSuccess(false); }}
          className="btn-primary flex items-center gap-2 shrink-0"
        >
          <UserPlus size={15} />
          {lang === 'vi' ? 'Mời người dùng' : 'Invite user'}
        </button>
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          onClick={resetInvite}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-bold text-lg text-navy">
                {lang === 'vi' ? 'Mời thành viên mới' : 'Invite new member'}
              </h2>
              <button onClick={resetInvite} className="text-ink-light hover:text-ink">
                <X size={18} />
              </button>
            </div>

            {inviteSuccess ? (
              <div className="py-4 space-y-4">
                <div className="text-center">
                  <div className="text-4xl mb-2">✅</div>
                  <p className="font-semibold text-navy">
                    {lang === 'vi' ? 'Đã tạo tài khoản!' : 'Account created!'}
                  </p>
                  <p className="text-sm text-ink-light mt-1">{inviteForm.fullName} · {inviteForm.email}</p>
                </div>
                {inviteLink ? (
                  <>
                    <p className="text-sm text-center text-ink">
                      {lang === 'vi'
                        ? 'Gửi liên kết này cho họ qua Zalo để đặt mật khẩu:'
                        : 'Send them this link via Zalo to set their password:'}
                    </p>
                    <div className="rounded-xl border px-3 py-2 text-[11px] font-mono break-all bg-cream/50" style={{ borderColor: '#E0D49A' }}>
                      {inviteLink}
                    </div>
                    <button onClick={copyInviteLink}
                      className="w-full py-3 rounded-xl font-bold text-white flex items-center justify-center gap-2"
                      style={{ backgroundColor: inviteLinkCopied ? '#16A34A' : '#1A4731' }}>
                      <KeyRound size={15} />
                      {inviteLinkCopied
                        ? (lang === 'vi' ? '✓ Đã sao chép' : '✓ Copied')
                        : (lang === 'vi' ? 'Sao chép liên kết' : 'Copy link')}
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-center text-amber-700">
                    {lang === 'vi' ? 'Tài khoản đã tạo. Dùng nút 🔑 để lấy liên kết đặt mật khẩu.' : 'Account created. Use the 🔑 button to get the password link.'}
                  </p>
                )}
                <button onClick={resetInvite} className="btn-secondary w-full">
                  {lang === 'vi' ? 'Xong' : 'Done'}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-ink-light uppercase tracking-wider">Email *</label>
                  <input type="email" value={inviteForm.email}
                    onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                    className="input mt-1 w-full" placeholder="nom@email.com" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink-light uppercase tracking-wider">
                    {lang === 'vi' ? 'Họ tên *' : 'Full name *'}
                  </label>
                  <input type="text" value={inviteForm.fullName}
                    onChange={e => setInviteForm(f => ({ ...f, fullName: e.target.value }))}
                    className="input mt-1 w-full" placeholder={lang === 'vi' ? 'Nguyễn Văn A' : 'Jane Doe'} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-ink-light uppercase tracking-wider">Role *</label>
                    <select value={inviteForm.role}
                      onChange={e => setInviteForm(f => ({ ...f, role: e.target.value as any, team: '' }))}
                      className="input mt-1 w-full">
                      <option value="chef">Chef</option>
                      <option value="worker">Worker</option>
                      <option value="assistant">Assistant</option>
                      <option value="lab_manager">Lab Manager</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-ink-light uppercase tracking-wider">Team</label>
                    <select value={inviteForm.team}
                      onChange={e => setInviteForm(f => ({ ...f, team: e.target.value }))}
                      className="input mt-1 w-full"
                      disabled={!['chef', 'worker'].includes(inviteForm.role)}>
                      <option value="">{!['chef', 'worker'].includes(inviteForm.role) ? '—' : (lang === 'vi' ? 'Chọn đội…' : 'Select…')}</option>
                      {TEAMS.map(t => (
                        <option key={t} value={t}>
                          {lang === 'vi' ? TEAM_LABELS[t as Team].vi : TEAM_LABELS[t as Team].en}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {inviteError && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    <span>{inviteError}</span>
                  </div>
                )}

                <div className="text-xs text-ink-light bg-cream/60 rounded-xl p-3">
                  {lang === 'vi'
                    ? 'Tài khoản được tạo ngay và bạn nhận liên kết để gửi qua Zalo (không cần email). Chỉ truy cập Lab App — không phải Catalogue App.'
                    : 'The account is created instantly and you get a link to share via Zalo (no email needed). Lab App access only — not the Catalogue App.'}
                </div>

                <div className="flex gap-3 pt-1">
                  <button onClick={resetInvite} className="btn-secondary flex-1">
                    {lang === 'vi' ? 'Hủy' : 'Cancel'}
                  </button>
                  <button
                    onClick={submitInvite}
                    disabled={inviting || !inviteForm.email || !inviteForm.fullName || (['chef', 'worker'].includes(inviteForm.role) && !inviteForm.team)}
                    className="btn-primary flex-1 flex items-center justify-center gap-2">
                    {inviting ? '…' : (lang === 'vi' ? 'Tạo tài khoản' : 'Create account')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
            const needsTeam = edit.role === 'chef' || edit.role === 'worker';
            const isDirty = !isAdmin && (edit.role !== user.role || edit.team !== (user.lab_profiles?.team ?? null));

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
                      disabled={!needsTeam}
                    >
                      {!needsTeam && <option value="">— {lang === 'vi' ? 'Tất cả' : 'All teams'} —</option>}
                      {needsTeam && <option value="">{lang === 'vi' ? 'Chọn đội…' : 'Select team…'}</option>}
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

                {/* Actions: reset link + save */}
                <div className="col-span-3 md:col-span-2 flex justify-end items-center gap-1.5">
                  {!isAdmin && (
                    <button
                      onClick={() => copyResetLink(user.id)}
                      disabled={linkFor === user.id}
                      title={lang === 'vi' ? 'Sao chép liên kết đặt lại mật khẩu (gửi qua Zalo)' : 'Copy password-reset link (send via Zalo)'}
                      className="p-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition-colors"
                      style={linkCopied === user.id
                        ? { borderColor: '#16A34A', color: '#16A34A', backgroundColor: '#F0FDF4' }
                        : { borderColor: '#E0D49A', color: '#92600A' }}
                    >
                      <KeyRound size={12} />
                      {linkFor === user.id ? '…' : linkCopied === user.id ? '✓' : null}
                    </button>
                  )}
                  {isDirty && (
                    <button
                      onClick={() => save(user)}
                      disabled={saving === user.id || (needsTeam && !edit.team)}
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
            { role: 'chef', en: "View own team's station, update production progress", vi: 'Xem trạm đội mình, cập nhật tiến độ sản xuất' },
            { role: 'worker', en: "View own team's station — read only, cannot mark progress", vi: 'Xem trạm đội mình — chỉ đọc, không thể cập nhật tiến độ' },
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
