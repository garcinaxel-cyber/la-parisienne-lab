'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Upload, ClipboardList, Users, LogOut, FlaskConical, BookOpen, Scan, Settings } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import type { UserRole } from '@/lib/types';

const NAV = [
  { href: '/dashboard', icon: LayoutDashboard, key: 'dashboard' as const },
  { href: '/import',    icon: Upload,          key: 'import'    as const },
  { href: '/orders',    icon: ClipboardList,   key: 'orders'    as const },
];
const ADMIN_NAV = [
  { href: '/admin/users',     icon: Users,    key: 'users'     as const },
  { href: '/admin/fiches',    icon: BookOpen, key: 'fiches'    as const },
  { href: '/admin/qr-codes',  icon: Scan,     key: 'qr_codes'  as const },
  { href: '/admin/settings',  icon: Settings, key: 'settings'  as const },
];

export default function Sidebar({ profile }: { profile: { full_name: string; role: UserRole } | null }) {
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
  }

  const isAdmin = profile?.role === 'admin' || profile?.role === 'lab_manager';

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col fixed inset-y-0 left-0 w-64 bg-navy text-white z-30">
        {/* Logo */}
        <div className="px-6 py-6 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gold flex items-center justify-center">
              <FlaskConical size={16} className="text-navy" />
            </div>
            <div>
              <div className="font-serif font-bold text-white text-sm leading-tight">La Parisienne</div>
              <div className="text-gold text-xs font-semibold tracking-widest">LAB</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ href, icon: Icon, key }) => (
            <Link key={href} href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                pathname === href || pathname.startsWith(href + '/')
                  ? 'bg-white/15 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}>
              <Icon size={18} />{t(key)}
            </Link>
          ))}
          {isAdmin && (
            <div className="pt-4 mt-4 border-t border-white/10">
              <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-white/40 mb-2">Admin</p>
              {ADMIN_NAV.map(({ href, icon: Icon, key }) => (
                <Link key={href} href={href}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    pathname.startsWith(href) ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}>
                  <Icon size={18} />{t(key)}
                </Link>
              ))}
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-white/10 space-y-3">
          {/* Lang toggle */}
          <div className="flex gap-1 px-3">
            {(['vi','en'] as const).map(l => (
              <button key={l} onClick={() => setLang(l)}
                className={`flex-1 rounded-lg py-1 text-xs font-semibold transition-colors ${
                  lang === l ? 'bg-gold text-navy' : 'text-white/50 hover:text-white'
                }`}>{l.toUpperCase()}</button>
            ))}
          </div>
          {profile && (
            <div className="px-3 py-2 rounded-xl bg-white/5">
              <div className="text-sm font-medium text-white truncate">{profile.full_name}</div>
              <div className="text-xs text-white/50 capitalize">{profile.role.replace('_',' ')}</div>
            </div>
          )}
          <button onClick={logout}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-white/60 hover:text-white hover:bg-white/10 transition-colors">
            <LogOut size={16} />{t('logout')}
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-20 bg-navy text-white px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={18} className="text-gold" />
          <span className="font-serif font-bold">La Parisienne <span className="text-gold text-xs">LAB</span></span>
        </div>
        <div className="flex gap-1">
          {NAV.map(({ href, icon: Icon }) => (
            <Link key={href} href={href}
              className={`p-2 rounded-lg transition-colors ${pathname === href ? 'bg-white/20' : 'hover:bg-white/10'}`}>
              <Icon size={18} />
            </Link>
          ))}
          {isAdmin && ADMIN_NAV.map(({ href, icon: Icon }) => (
            <Link key={href} href={href} className="p-2 rounded-lg hover:bg-white/10">
              <Icon size={18} />
            </Link>
          ))}
        </div>
      </header>
      <div className="lg:hidden h-14" /> {/* Spacer */}
    </>
  );
}
