'use client';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

export default function ExceptionalTabs({ initial, orders, cakes, cakesBadge }: {
  initial: 'orders' | 'cakes'; orders: ReactNode; cakes: ReactNode; cakesBadge: number;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [tab, setTab] = useState(initial);
  const btn = (k: 'orders' | 'cakes', label: string, badge = 0) => (
    <button onClick={() => { setTab(k); try { history.replaceState(null, '', k === 'cakes' ? '?tab=cakes' : location.pathname); } catch {} }}
      className={`relative rounded-lg px-3 py-2 text-sm font-semibold ${tab === k ? 'bg-amber-800 text-white' : 'bg-stone-100 text-stone-600'}`}>
      {label}
      {badge > 0 && <span className="ml-2 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">{badge}</span>}
    </button>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {btn('orders', vi ? 'Đơn thủ công' : 'Manual orders')}
        {btn('cakes', vi ? 'Bánh sinh nhật từ Odoo' : 'Birthday cakes from Odoo', cakesBadge)}
      </div>
      <div hidden={tab !== 'orders'}>{orders}</div>
      <div hidden={tab !== 'cakes'}>{cakes}</div>
    </div>
  );
}
