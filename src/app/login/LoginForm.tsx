'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { Loader2 } from 'lucide-react';

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirect') ?? '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) { setError(err.message); setLoading(false); return; }
    // Redirect to original destination (e.g. /station/hung from QR code)
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <div className="relative min-h-screen bg-cream flex items-center justify-center p-4 overflow-hidden isolate">
      {/* Background watermark — decorative, blended into the cream backdrop */}
      <img
        src="/logo-mark.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none select-none absolute -right-24 -top-16 w-[520px] max-w-none opacity-[0.06] rotate-[-4deg] -z-10 sm:-right-16 sm:-top-24"
      />
      <img
        src="/logo-mark.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none select-none absolute -left-32 bottom-[-140px] w-[380px] max-w-none opacity-[0.05] rotate-[8deg] -z-10 hidden sm:block"
      />

      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/logo-mark.png" alt="La Parisienne" className="mx-auto h-20 w-auto mb-3" />
          <div className="font-serif text-3xl font-bold text-navy">La Parisienne</div>
          <div className="mt-1 text-sm font-medium text-gold tracking-widest uppercase">Lab</div>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-ink-light uppercase tracking-wider mb-1.5">Email</label>
              <input className="input" type="email" value={email}
                onChange={e => setEmail(e.target.value)} required autoComplete="email" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-light uppercase tracking-wider mb-1.5">
                Mật khẩu / Password
              </label>
              <input className="input" type="password" value={password}
                onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button type="submit" disabled={loading}
              className="btn-primary w-full justify-center mt-2 disabled:opacity-60">
              {loading ? <><Loader2 size={15} className="animate-spin" /> Đang đăng nhập…</> : 'Đăng nhập / Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-ink-light mt-6">La Parisienne Lab — Internal use only</p>
      </div>
    </div>
  );
}
