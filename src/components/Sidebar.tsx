'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Upload, ClipboardList, Users, LogOut, BookOpen, Scan, TrendingUp, Ban, PackageCheck, Cake, FileSpreadsheet, Zap, ShieldCheck, ClipboardCheck, Box } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import type { UserRole } from '@/lib/types';

const NAV = [
  { href: '/dashboard', icon: LayoutDashboard, key: 'dashboard' as const },
  // Import / Production export: admin-only per Axel (2026-08-08) — decluttering the
  // lab_manager/assistant sidebar, they don't use these day to day.
  { href: '/import',    icon: Upload,          key: 'import'    as const, adminOnly: true },
  { href: '/orders',    icon: ClipboardList,   key: 'orders'    as const },
  { href: '/delivery-check', icon: ClipboardCheck, labelVi: 'Kiểm tra giao hàng', labelEn: 'Delivery check' },
  { href: '/birthday-cakes', icon: Cake,       labelVi: 'Bánh sinh nhật', labelEn: 'Birthday cakes' },
  { href: '/exceptional-orders', icon: Zap,    labelVi: 'Đơn đặc biệt', labelEn: 'Exceptional orders' },
  { href: '/reception', icon: PackageCheck,   labelVi: 'Nhập kho', labelEn: 'Stock reception' },
  { href: '/inventory', icon: Box,            labelVi: 'Kiểm kê', labelEn: 'Inventaire' },
  { href: '/production-history', icon: FileSpreadsheet, labelVi: 'Lịch sử sản xuất', labelEn: 'Production export', adminOnly: true },
  // QR codes: moved out of the Admin section so assistants see it too (2026-08-13, Axel —
  // assistants need to open a chef's station view same as a chef would, e.g. to check what's
  // showing on their tablet). The page itself has no role gate of its own, just this sidebar
  // entry, so this alone is enough to unlock it — no adminOnly, visible to admin/lab_manager/
  // assistant (everyone who reaches this sidebar; chef/worker never do, they're on /station/me).
  { href: '/admin/qr-codes',  icon: Scan,     key: 'qr_codes'  as const },
];
const ADMIN_NAV = [
  { href: '/analytics',       icon: TrendingUp, key: 'analytics' as const, adminOnly: true },
  // Users: admin-only per Axel (2026-08-08) — was already page-blocked for lab_manager,
  // just wasn't hidden from the sidebar yet.
  { href: '/admin/users',     icon: Users,    key: 'users'     as const, adminOnly: true },
  { href: '/admin/fiches',    icon: BookOpen, key: 'fiches'    as const },
  { href: '/admin/excluded',  icon: Ban,      key: 'excluded'  as const },
  // Control tool over everyone else's work (Odoo-vs-app reconciliation), not an operational
  // page — admin only, deliberately excluded from lab_manager per Axel's explicit request.
  { href: '/admin/reconciliation', icon: ShieldCheck, labelVi: 'Đối chiếu Odoo', labelEn: 'Reconciliation', adminOnly: true },
];

export default function Sidebar({ profile, pendingTransfers = 0, pendingExceptional = 0, reconciliationIssues = 0 }: { profile: { full_name: string; role: UserRole } | null; pendingTransfers?: number; pendingExceptional?: number; reconciliationIssues?: number }) {
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const labelFor = (it: { key?: string; labelVi?: string; labelEn?: string }) =>
    it.labelVi ? (lang === 'vi' ? it.labelVi : it.labelEn) : t(it.key as any);

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
            <img src="/logo-mark-gold.png" alt="" className="w-9 h-9 object-contain shrink-0" />
            <div>
              <div className="font-serif font-bold text-white text-sm leading-tight">La Parisienne</div>
              <div className="text-gold text-xs font-semibold tracking-widest">MANUFACTURING</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.filter(n => !n.adminOnly || profile?.role === 'admin').map((item) => {
            const { href, icon: Icon } = item;
            return (
              <Link key={href} href={href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  pathname === href || pathname.startsWith(href + '/')
                    ? 'bg-white/15 text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`}>
                <Icon size={18} /><span className="flex-1">{labelFor(item)}</span>
                {href === '/reception' && pendingTransfers > 0 && (
                  <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-gold text-navy">{pendingTransfers}</span>
                )}
                {href === '/exceptional-orders' && pendingExceptional > 0 && (
                  <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-gold text-navy">{pendingExceptional}</span>
                )}
              </Link>
            );
          })}
          {isAdmin && (
            <div className="pt-4 mt-4 border-t border-white/10">
              <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-white/40 mb-2">Admin</p>
              {ADMIN_NAV.filter(n => !n.adminOnly || profile?.role === 'admin').map((item) => {
                const { href, icon: Icon } = item;
                return (
                  <Link key={href} href={href}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                      pathname.startsWith(href) ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}>
                    <Icon size={18} /><span className="flex-1">{labelFor(item)}</span>
                    {href === '/admin/reconciliation' && reconciliationIssues > 0 && (
                      <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-gold text-navy">{reconciliationIssues}</span>
                    )}
                  </Link>
                );
              })}
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

      {/* Mobile top bar — labels under icons, active state, horizontal scroll if needed */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-20 bg-navy text-white">
        <div className="px-3 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/logo-mark-gold.png" alt="" className="w-6 h-6 object-contain shrink-0" />
            <span className="font-serif font-bold text-sm truncate">La Parisienne</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <div className="flex gap-0.5 rounded-lg p-0.5 bg-white/10">
              {(['vi','en'] as const).map(l => (
                <button key={l} onClick={() => setLang(l)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${lang === l ? 'bg-gold text-navy' : 'text-white/60'}`}>
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
            <button onClick={logout} className="p-1.5 rounded-lg hover:bg-white/10" aria-label={t('logout')}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
        <nav className="flex overflow-x-auto border-t border-white/10">
          {[...NAV.filter(n => !n.adminOnly || profile?.role === 'admin'), ...(isAdmin ? ADMIN_NAV.filter(n => !n.adminOnly || profile?.role === 'admin') : [])].map((item) => {
            const { href, icon: Icon } = item;
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link key={href} href={href}
                className={`relative flex-1 min-w-[64px] flex flex-col items-center gap-0.5 py-1.5 text-[10px] font-semibold transition-colors ${
                  active ? 'text-gold border-b-2 border-gold' : 'text-white/60 border-b-2 border-transparent'
                }`}>
                <Icon size={17} />
                <span className="truncate max-w-[72px]">{labelFor(item)}</span>
                {href === '/reception' && pendingTransfers > 0 && (
                  <span className="absolute top-0.5 right-2 text-[9px] font-bold rounded-full px-1 bg-gold text-navy">{pendingTransfers}</span>
                )}
                {href === '/exceptional-orders' && pendingExceptional > 0 && (
                  <span className="absolute top-0.5 right-2 text-[9px] font-bold rounded-full px-1 bg-gold text-navy">{pendingExceptional}</span>
                )}
                {href === '/admin/reconciliation' && reconciliationIssues > 0 && (
                  <span className="absolute top-0.5 right-2 text-[9px] font-bold rounded-full px-1 bg-gold text-navy">{reconciliationIssues}</span>
                )}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
