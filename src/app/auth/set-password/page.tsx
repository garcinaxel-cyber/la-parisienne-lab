'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

// Landing page for invite + password-recovery email links.
// The Supabase link establishes a session (PKCE code in the URL), then the
// user chooses their password here. Public route (excluded from middleware).
export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [sessionOk, setSessionOk] = useState(false);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));

      // 1. Error passed back by Supabase (expired/consumed link)
      if (hash.get('error') || url.searchParams.get('error')) { setReady(true); return; }

      // 2. token_hash link (admin 🔑 button / invite) — verify works on any device
      const tokenHash = url.searchParams.get('token_hash');
      const type = url.searchParams.get('type');
      if (tokenHash && type) {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any });
        setSessionOk(!error);
        setReady(true);
        return;
      }

      // 3. Implicit fragment tokens (#access_token / #refresh_token)
      const at = hash.get('access_token');
      const rt = hash.get('refresh_token');
      if (at && rt) {
        const { error } = await supabase.auth.setSession({ access_token: at, refresh_token: rt });
        setSessionOk(!error);
        setReady(true);
        return;
      }

      // 4. PKCE ?code= (only works on the initiating device) — let the client try, then poll
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        const { data } = await supabase.auth.getSession();
        if (data.session) { setSessionOk(true); setReady(true); clearInterval(timer); }
        else if (tries > 8) { setReady(true); clearInterval(timer); }
      }, 500);
    })();
  }, []);

  async function save() {
    setError(null);
    if (pw1.length < 8) { setError('Mật khẩu tối thiểu 8 ký tự / Password must be at least 8 characters'); return; }
    if (pw1 !== pw2) { setError('Mật khẩu không khớp / Passwords do not match'); return; }
    setSaving(true);
    const supabase = createClient();
    const { error: err } = await supabase.auth.updateUser({ password: pw1 });
    if (err) { setError(err.message); setSaving(false); return; }
    setDone(true);
    // Route by role: chefs/workers land on their station, others on the dashboard
    const { data: { session } } = await supabase.auth.getSession();
    const { data: profile } = session
      ? await supabase.from('profiles').select('role').eq('id', session.user.id).single()
      : { data: null };
    setTimeout(() => {
      router.push(['chef', 'worker'].includes(profile?.role ?? '') ? '/station/me' : '/dashboard');
    }, 1200);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: '#FFF4CC' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="font-serif text-3xl font-bold" style={{ color: '#1A4731' }}>La Parisienne</h1>
          <p className="text-xs font-bold tracking-widest" style={{ color: '#C9A84C' }}>MANUFACTURING</p>
        </div>
        <div className="bg-white rounded-2xl p-6 space-y-4" style={{ border: '1px solid #E0D49A' }}>
          {!ready && (
            <p className="text-sm text-center text-ink-light py-4">Đang xác thực… / Verifying…</p>
          )}
          {ready && !sessionOk && (
            <p className="text-sm text-center py-4" style={{ color: '#DC2626' }}>
              Liên kết đã hết hạn hoặc không hợp lệ. Yêu cầu quản trị viên gửi lại lời mời.<br />
              <span className="text-ink-light">Link expired or invalid — ask your admin to resend the invite.</span>
            </p>
          )}
          {ready && sessionOk && !done && (
            <>
              <div>
                <h2 className="font-bold text-base" style={{ color: '#1A4731' }}>
                  Tạo mật khẩu / Set your password
                </h2>
                <p className="text-xs text-ink-light mt-0.5">
                  Tối thiểu 8 ký tự / At least 8 characters
                </p>
              </div>
              <input
                type="password" value={pw1} onChange={e => setPw1(e.target.value)}
                placeholder="Mật khẩu mới / New password"
                className="w-full rounded-xl border px-3 py-3 focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A', fontSize: 16 }} autoFocus />
              <input
                type="password" value={pw2} onChange={e => setPw2(e.target.value)}
                placeholder="Nhập lại / Confirm password"
                className="w-full rounded-xl border px-3 py-3 focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A', fontSize: 16 }} />
              {error && (
                <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>{error}</p>
              )}
              <button onClick={save} disabled={saving}
                className="w-full py-3 rounded-xl font-bold text-white disabled:opacity-60"
                style={{ backgroundColor: '#1A4731' }}>
                {saving ? '…' : 'Lưu mật khẩu / Save password'}
              </button>
            </>
          )}
          {done && (
            <p className="text-sm text-center py-4" style={{ color: '#16A34A' }}>
              ✓ Mật khẩu đã lưu — đang chuyển hướng… / Password saved — redirecting…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
