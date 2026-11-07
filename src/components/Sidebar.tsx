'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ListChecks, ChefHat, ClipboardCheck, Zap, PackageCheck, Boxes, Truck, Factory, Store, TrendingUp,
  BookOpen, Users, LogOut, MoreHorizontal, X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import type { UserRole } from '@/lib/types';
import { FAMILIES, visibleNav, splitPrimary, activeItem, badgeOf, badgeIsRed, type Badges, type NavItem } from '@/lib/nav';

// Menu of the lab app (redesign 2026-11-07). Entries, roles and order come from src/lib/nav.ts.
// Desktop: fixed green sidebar grouped by moment of the day. Phone: slim top bar + bottom bar
// with 4 entries per role and "More" for the rest (same pattern as the chefs' station).
const ICONS: Record<string, any> = { ListChecks, ChefHat, ClipboardCheck, Zap, PackageCheck, Boxes, Truck, Factory, Store, TrendingUp, BookOpen, Users };

type Profile = { full_name: string; role: UserRole; can_purchase?: boolean } | null;

function Badge({ n, red, small }: { n: number; red: boolean; small?: boolean }) {
  if (!n) return null;
  return (
    <span className={`${small ? 'text-[9px] px-1 min-w-[16px]' : 'text-[10px] px-1.5 min-w-[20px]'} font-bold rounded-full py-0.5 text-center leading-none tabular-nums`}
      style={red ? { backgroundColor: '#DC2626', color: '#fff' } : { backgroundColor: '#C9A84C', color: '#1A4731' }}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

const ROLE_LABEL: Record<string, { vi: string; en: string }> = {
  admin: { vi: 'Quản trị', en: 'Admin' }, lab_manager: { vi: 'Quản lý Lab', en: 'Lab manager' },
  assistant: { vi: 'Trợ lý', en: 'Assistant' }, purchasing: { vi: 'Mua hàng', en: 'Purchasing' },
};

export default function Sidebar({ profile, badges = {} }: { profile: Profile; badges?: Badges }) {
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [pathname]);

  const items = visibleNav(profile);
  const current = activeItem(items, pathname);
  const { primary, more } = splitPrimary(items, profile?.role);
  const L = (it: { vi: string; en: string }) => (lang === 'vi' ? it.vi : it.en);
  const moreCount = more.reduce((t, it) => t + (it.id === 'today' ? 0 : badgeOf(badges, it.badge)), 0);
  const moreRed = more.some(it => badgeOf(badges, it.badge) > 0 && badgeIsRed(badges, it.badge));

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
  }

  const LangToggle = ({ dark }: { dark?: boolean }) => (
    <div className={`flex gap-0.5 rounded-lg p-0.5 ${dark ? 'bg-white/10' : 'bg-navy/5'}`}>
      {(['vi', 'en'] as const).map(l => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
          className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition-colors ${lang === l ? 'bg-gold text-navy' : dark ? 'text-white/60 hover:text-white' : 'text-ink-light'}`}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {/* ── Desktop sidebar ───────────────────────────────────────────── */}
      <aside className="hidden lg:flex flex-col fixed inset-y-0 left-0 w-64 bg-navy text-white z-30">
        <div className="px-5 py-5 border-b border-white/10 flex items-center gap-3">
          <img src="/logo-mark-gold.png" alt="" className="w-9 h-9 object-contain shrink-0" />
          <div>
            <div className="font-serif font-bold text-white text-[15px] leading-tight">La Paris</div>
            <div className="text-gold text-[10px] font-semibold tracking-[0.2em]">LAB</div>
          </div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-3" aria-label="Main">
          {FAMILIES.map(fam => {
            const famItems = items.filter(it => it.family === fam.id);
            if (!famItems.length) return null;
            return (
              <div key={fam.id} className="mb-2">
                {fam.id !== 'today' && (
                  <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">{L(fam)}</p>
                )}
                <div className="space-y-0.5">
                  {famItems.map(it => {
                    const Icon = ICONS[it.icon] ?? ListChecks;
                    const on = current?.id === it.id;
                    const n = badgeOf(badges, it.badge);
                    return (
                      <Link key={it.id} href={it.href} prefetch={false}
                        className={`flex items-center gap-3 px-3 py-2 rounded-xl text-[13.5px] font-medium transition-colors ${
                          on ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}>
                        <Icon size={17} className={on ? 'text-gold' : ''} />
                        <span className="flex-1 truncate">{L(it)}</span>
                        <Badge n={n} red={badgeIsRed(badges, it.badge)} />
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="px-3 py-3 border-t border-white/10 space-y-2">
          <div className="flex items-center justify-between px-2">
            <LangToggle dark />
            <button onClick={logout} className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-white/60 hover:text-white hover:bg-white/10">
              <LogOut size={14} />{t('logout')}
            </button>
          </div>
          {profile && (
            <div className="px-3 py-2 rounded-xl bg-white/5">
              <div className="text-sm font-medium text-white truncate">{profile.full_name}</div>
              <div className="text-xs text-white/50">{ROLE_LABEL[profile.role] ? L(ROLE_LABEL[profile.role]) : profile.role}</div>
            </div>
          )}
        </div>
      </aside>

      {/* ── Phone: slim top bar ───────────────────────────────────────── */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-30 bg-navy text-white"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="h-12 px-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/logo-mark-gold.png" alt="" className="w-6 h-6 object-contain shrink-0" />
            <span className="font-serif font-bold text-[15px] truncate">{current ? L(current) : 'La Paris Lab'}</span>
          </div>
          <LangToggle dark />
        </div>
      </header>

      {/* ── Phone: bottom bar ─────────────────────────────────────────── */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-border-soft"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label="Main">
        <div className={`grid h-16 ${more.length ? 'grid-cols-5' : primary.length === 2 ? 'grid-cols-2' : 'grid-cols-4'}`}>
          {primary.map(it => {
            const Icon = ICONS[it.icon] ?? ListChecks;
            const on = current?.id === it.id && !moreOpen;
            const n = badgeOf(badges, it.badge);
            return (
              <Link key={it.id} href={it.href} prefetch={false}
                className={`relative flex flex-col items-center justify-center gap-1 text-[10.5px] font-semibold ${on ? 'text-navy' : 'text-ink-light'}`}>
                {on && <span className="absolute top-0 inset-x-4 h-[3px] rounded-b bg-gold" />}
                <span className="relative">
                  <Icon size={21} strokeWidth={on ? 2.4 : 1.9} />
                  {n > 0 && <span className="absolute -top-1.5 -right-3"><Badge n={n} red={badgeIsRed(badges, it.badge)} small /></span>}
                </span>
                <span className="truncate max-w-[72px]">{L(it)}</span>
              </Link>
            );
          })}
          {more.length > 0 && (
            <button onClick={() => setMoreOpen(o => !o)} aria-expanded={moreOpen}
              className={`relative flex flex-col items-center justify-center gap-1 text-[10.5px] font-semibold ${moreOpen || (current && more.includes(current)) ? 'text-navy' : 'text-ink-light'}`}>
              {(moreOpen || (current && more.includes(current))) && <span className="absolute top-0 inset-x-4 h-[3px] rounded-b bg-gold" />}
              <span className="relative">
                <MoreHorizontal size={21} />
                {moreCount > 0 && <span className="absolute -top-1.5 -right-3"><Badge n={moreCount} red={moreRed} small /></span>}
              </span>
              <span>{lang === 'vi' ? 'Thêm' : 'More'}</span>
            </button>
          )}
        </div>
      </nav>

      {/* ── Phone: "More" sheet ───────────────────────────────────────── */}
      {moreOpen && (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true">
          <button className="absolute inset-0 bg-black/30" aria-label="Close" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 bg-cream rounded-t-3xl shadow-xl px-4 pt-3"
            style={{ paddingBottom: 'calc(80px + env(safe-area-inset-bottom, 0px))' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="w-10 h-1 rounded-full bg-navy/15 mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
              <span className="font-serif font-bold text-navy text-lg mt-2">{lang === 'vi' ? 'Thêm' : 'More'}</span>
              <button onClick={() => setMoreOpen(false)} className="p-2 rounded-full text-ink-light mt-2" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {more.map(it => {
                const Icon = ICONS[it.icon] ?? ListChecks;
                const n = badgeOf(badges, it.badge);
                const on = current?.id === it.id;
                return (
                  <Link key={it.id} href={it.href} prefetch={false}
                    className={`relative rounded-2xl bg-white border px-2 py-3 flex flex-col items-center gap-1.5 text-center text-[12px] font-semibold ${on ? 'border-gold text-navy' : 'border-border-soft text-ink'}`}>
                    <Icon size={20} className="text-navy" />
                    <span className="leading-tight">{L(it)}</span>
                    {n > 0 && <span className="absolute top-1.5 right-1.5"><Badge n={n} red={badgeIsRed(badges, it.badge)} small /></span>}
                  </Link>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-between rounded-2xl bg-white border border-border-soft px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink truncate">{profile?.full_name}</div>
                <div className="text-xs text-ink-light">{profile && ROLE_LABEL[profile.role] ? L(ROLE_LABEL[profile.role]) : profile?.role}</div>
              </div>
              <button onClick={logout} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold text-navy border border-border-soft">
                <LogOut size={15} />{t('logout')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
