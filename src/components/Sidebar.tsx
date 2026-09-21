'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, ClipboardList, Users, LogOut, BookOpen, Scan, TrendingUp, Ban, PackageCheck, Cake, Zap, ShieldCheck, ClipboardCheck, Box, Store, Trash2, ShoppingBag, UserCog, CalendarDays, FolderArchive, Eye } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import type { UserRole } from '@/lib/types';

// `family` groups items under a section header on the DESKTOP sidebar only (Axel, 2026-09-21 —
// "Atelier" design pass: 20 flat links → 4 pliable families: Aujourd'hui/Production/Boutiques/
// Pilotage). Purely presentational — same hrefs, same adminOnly gating, same badges as before.
// The MOBILE top bar stays flat/scrollable and ungrouped on purpose: Axel chose to keep it
// exactly as-is for the assistant role ("10 onglets à plat, c'est mieux" — zero relearning).
const FAMILY_LABEL: Record<string, { vi: string; en: string }> = {
  today:      { vi: 'Hôm nay',      en: "Aujourd'hui" },
  production: { vi: 'Sản xuất',     en: 'Production' },
  shops:      { vi: 'Cửa hàng',     en: 'Boutiques' },
  piloting:   { vi: 'Điều hành',    en: 'Pilotage' },
};

const NAV = [
  { href: '/dashboard', icon: LayoutDashboard, key: 'dashboard' as const, family: 'today' },
  // "Production Orders" (t('orders')) — hidden from the assistant role specifically (Axel,
  // 2026-09-21, prod pass: "enlève de la vue des assistantes le production order"). Still
  // visible to admin/lab_manager. Route + component untouched — visibility only.
  { href: '/orders',    icon: ClipboardList,   key: 'orders'    as const, family: 'production', hideFor: ['assistant'] as UserRole[] },
  { href: '/delivery-check', icon: ClipboardCheck, labelVi: 'Kiểm tra giao hàng', labelEn: 'Delivery check', family: 'production' },
  { href: '/birthday-cakes', icon: Cake,       labelVi: 'Bánh sinh nhật', labelEn: 'Birthday cakes', family: 'production' },
  { href: '/exceptional-orders', icon: Zap,    labelVi: 'Đơn đặc biệt', labelEn: 'Exceptional orders', family: 'production' },
  { href: '/reception', icon: PackageCheck,   labelVi: 'Nhập kho', labelEn: 'Stock reception', family: 'production' },
  { href: '/inventory', icon: Box,            labelVi: 'Kiểm kê', labelEn: 'Inventaire', family: 'production' },
  // LAB's own scrap/loss report (2026-08-27, Axel: "fonction de scrap... pour les produits casse
  // du lab") — same visibility as the other operational items above, no adminOnly.
  { href: '/lab-scrap', icon: Trash2,         labelVi: 'Hao hụt Lab', labelEn: 'Lab scrap', family: 'production' },
  { href: '/admin/shop-access', icon: Store,  labelVi: 'Truy cập cửa hàng', labelEn: 'Accès boutiques', family: 'shops' },
  // Online-sales interface (2026-09-06): admin entry point to the online seller's space
  // (/online-orders lives outside (app) so she never sees this sidebar; admin sees all her orders).
  // adminOnly already keeps this out of the assistant's view (Axel, 2026-09-21 confirmed it
  // should stay that way) — literal role === 'admin' below, lab_manager doesn't see it either.
  { href: '/online-orders', icon: ShoppingBag,     labelVi: 'Bán hàng online', labelEn: 'Ventes en ligne', adminOnly: true, family: 'shops' },
  // QR codes: moved out of the Admin section so assistants see it too (2026-08-13, Axel —
  // assistants need to open a chef's station view same as a chef would, e.g. to check what's
  // showing on their tablet). The page itself has no role gate of its own, just this sidebar
  // entry, so this alone is enough to unlock it — no adminOnly, visible to admin/lab_manager/
  // assistant (everyone who reaches this sidebar; chef/worker never do, they're on /station/me).
  { href: '/admin/qr-codes',  icon: Scan,     key: 'qr_codes'  as const, family: 'shops' },
];
const ADMIN_NAV = [
  { href: '/analytics',       icon: TrendingUp, key: 'analytics' as const, adminOnly: true, family: 'piloting' },
  // Users: admin-only per Axel (2026-08-08) — was already page-blocked for lab_manager,
  // just wasn't hidden from the sidebar yet.
  { href: '/admin/users',     icon: Users,    key: 'users'     as const, adminOnly: true, family: 'piloting' },
  { href: '/admin/fiches',    icon: BookOpen, key: 'fiches'    as const, family: 'piloting' },
  { href: '/admin/excluded',  icon: Ban,      key: 'excluded'  as const, family: 'piloting' },
  // Control tool over everyone else's work (4 automated checks: Odoo reconciliation,
  // delivery-check coverage, production→stock, stock→Odoo), not an operational page — admin
  // only, deliberately excluded from lab_manager per Axel's explicit request. Renamed "Check"
  // 2026-08-20 — URL kept as /admin/reconciliation on purpose (zero churn).
  { href: '/admin/reconciliation', icon: ShieldCheck, labelVi: 'Check', labelEn: 'Check', adminOnly: true, family: 'piloting' },
  // Shop manager accounts (2026-09-10) — individual logins for the shop managers, admin-only
  // provisioning (create/update the 3 real accounts) + a read-only roster.
  { href: '/admin/shop-managers', icon: UserCog, labelVi: 'Quản lý cửa hàng', labelEn: 'Shop managers', adminOnly: true, family: 'shops' },
  // One-click preview of the managers' own cockpit (Axel, 2026-09-21 — "comme les QR codes des
  // chefs, accéder à leur interface facilement en un clic"). Opens /shop-manager directly, same
  // "Open →" pattern as the station QR codes page; admin is now allowed through that route's own
  // gate too (src/app/shop-manager/page.tsx). Read-only in spirit — the cockpit's own action file
  // only exposes the two recap reads, no write action lives there.
  { href: '/shop-manager', icon: Eye, labelVi: 'Xem giao diện quản lý', labelEn: 'Interface managers', adminOnly: true, newTab: true, family: 'shops' },
  // Temporary "event" shops (2026-09-12) — create/close, linked to an Odoo warehouse Axel
  // configures himself; the app only looks it up by code, never creates it.
  { href: '/admin/events', icon: CalendarDays, labelVi: 'Event shops', labelEn: 'Event shops', adminOnly: true, family: 'shops' },
  // Archives (2026-09-19) — exports Excel mensuels + sauvegardes hebdo (bucket lab-archives) et
  // état de la rétention. Lecture seule, admin-only.
  { href: '/admin/archives', icon: FolderArchive, labelVi: 'Lưu trữ', labelEn: 'Archives', adminOnly: true, family: 'piloting' },
];
const FAMILY_ORDER = ['today', 'production', 'shops', 'piloting'] as const;

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

        {/* Nav — scrolls internally now that the list has grown (inventaire + accès boutiques
            added 2026-08-19) so the footer (lang toggle + logout) never gets pushed off-screen
            with no way to reach it. min-h-0 is required alongside flex-1 for a flex child to
            actually be allowed to shrink and scroll instead of just overflowing its parent.
            Grouped by family (Atelier pass, 2026-09-21) — same items, same hrefs, same badges,
            just under a small uppercase section header instead of one 20-item flat list. */}
        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-4">
          {(() => {
            const visibleNav = NAV.filter(n => (!n.adminOnly || profile?.role === 'admin') && !(n as any).hideFor?.includes(profile?.role));
            const visibleAdmin = isAdmin ? ADMIN_NAV.filter(n => !n.adminOnly || profile?.role === 'admin') : [];
            const all = [...visibleNav, ...visibleAdmin];
            return FAMILY_ORDER.map((fam) => {
              const items = all.filter(it => it.family === fam);
              if (items.length === 0) return null;
              return (
                <div key={fam} className="mb-1">
                  <p className="px-3 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">
                    {lang === 'vi' ? FAMILY_LABEL[fam].vi : FAMILY_LABEL[fam].en}
                  </p>
                  <div className="space-y-1">
                    {items.map((item) => {
                      const { href, icon: Icon } = item as typeof item & { newTab?: boolean };
                      return (
                        <Link key={href} href={href} {...((item as any).newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
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
                          {href === '/admin/reconciliation' && reconciliationIssues > 0 && (
                            <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-gold text-navy">{reconciliationIssues}</span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()}
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
        {/* Fixed-width, non-shrinking tabs (2026-09-21 fix — Axel: "beaucoup d'onglets texte qui
            se chevauche, pas lisible"). The old flex-1+min-w combo let flex-shrink compress each
            tab below its label's natural width once there were 10+ of them, so labels and badges
            bled into the next tab. w-16 + shrink-0 gives every tab the same fixed width and lets
            overflow-x-auto do the scrolling instead — no more overlap, whatever the tab count. */}
        <nav className="flex overflow-x-auto border-t border-white/10">
          {[...NAV.filter(n => (!n.adminOnly || profile?.role === 'admin') && !(n as any).hideFor?.includes(profile?.role)), ...(isAdmin ? ADMIN_NAV.filter(n => !n.adminOnly || profile?.role === 'admin') : [])].map((item) => {
            const { href, icon: Icon } = item as typeof item & { newTab?: boolean };
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link key={href} href={href} {...((item as any).newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={`relative shrink-0 w-16 flex flex-col items-center gap-0.5 py-1.5 text-[10px] font-semibold transition-colors ${
                  active ? 'text-gold border-b-2 border-gold' : 'text-white/60 border-b-2 border-transparent'
                }`}>
                <Icon size={17} />
                <span className="truncate max-w-[60px] text-center leading-tight">{labelFor(item)}</span>
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
