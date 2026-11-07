'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import type { UserRole } from '@/lib/types';
import { visibleNav, visibleTabs, activeItem, activeTab, badgeOf, badgeIsRed, type Badges } from '@/lib/nav';

// Tab strip at the top of a section that groups several pages (redesign 2026-11-07): e.g.
// Shops = shop screens · stations QR · events · managers · online sales. Each tab is still its
// own URL; on a phone the strip scrolls sideways and sticks under the top bar.
export default function SectionTabs({ profile, badges = {} }: { profile: { role: UserRole; can_purchase?: boolean } | null; badges?: Badges }) {
  const { lang } = useI18n();
  const pathname = usePathname() ?? '';
  const item = activeItem(visibleNav(profile), pathname);
  if (!item) return null;
  const tabs = visibleTabs(item, profile);
  if (tabs.length < 2) return null;
  const on = activeTab(tabs, pathname);

  return (
    <div className="sticky top-12 lg:top-0 z-20 bg-cream/95 backdrop-blur border-b border-border-soft">
      <div className="max-w-6xl mx-auto px-3 sm:px-4">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar -mx-1 px-1" role="tablist">
          {tabs.map(t => {
            const active = on?.href === t.href;
            const n = badgeOf(badges, t.badge);
            return (
              <Link key={t.href} href={t.href} prefetch={false} role="tab" aria-selected={active}
                {...(t.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={`shrink-0 relative flex items-center gap-1.5 px-3 py-3 text-[13px] font-semibold whitespace-nowrap transition-colors ${
                  active ? 'text-navy' : 'text-ink-light hover:text-navy'}`}>
                {lang === 'vi' ? t.vi : t.en}
                {t.external && <span aria-hidden className="text-[10px] opacity-60">↗</span>}
                {n > 0 && (
                  <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none tabular-nums"
                    style={badgeIsRed(badges, t.badge) ? { backgroundColor: '#DC2626', color: '#fff' } : { backgroundColor: '#C9A84C', color: '#1A4731' }}>{n}</span>
                )}
                {active && <span className="absolute left-3 right-3 bottom-0 h-[3px] rounded-t bg-gold" />}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
