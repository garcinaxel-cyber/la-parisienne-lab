'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ClipboardCheck, ChevronRight, CircleAlert, CheckCircle2 } from 'lucide-react';

type OrderRow = {
  order_ref: string; delivery_date: string; shop_name: string;
  status: string; checked: number; total: number;
};

export default function DeliveryCheckIndexView({ today, orders, pendingCakesCount }: {
  today: string; orders: OrderRow[]; pendingCakesCount: number;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const byDate = new Map<string, OrderRow[]>();
  for (const o of orders) (byDate.get(o.delivery_date) ?? byDate.set(o.delivery_date, []).get(o.delivery_date)!).push(o);
  const dates = Array.from(byDate.keys()).sort();

  const dayLabel = (d: string) => {
    const label = new Date(d + 'T12:00:00Z').toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Ho_Chi_Minh',
    });
    return d === today ? `${label} · ${vi ? 'hôm nay' : "aujourd'hui"}` : label;
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <ClipboardCheck size={24} /> {vi ? 'Kiểm tra giao hàng' : 'Check livraison'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {vi ? 'Kiểm số lượng theo đơn, điều chỉnh nếu cần, sau đó xác nhận.' : 'Vérifier la quantité par commande, ajuster si besoin, puis valider.'}
          </p>
        </div>
        {pendingCakesCount > 0 && (
          <Link href="/delivery-check/unreconciled"
            className="text-xs font-semibold rounded-full px-3 py-1.5 inline-flex items-center gap-1.5"
            style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
            <CircleAlert size={13} /> {pendingCakesCount} {vi ? 'chưa đồng bộ Odoo' : 'non conciliés Odoo'}
          </Link>
        )}
      </div>

      {orders.length === 0 ? (
        <div className="card p-10 text-center">
          <ClipboardCheck size={44} className="mx-auto mb-3 text-green-600" />
          <p className="font-semibold text-navy">{vi ? 'Không có đơn nào' : 'Aucune commande'}</p>
          <p className="text-sm text-ink-light mt-1">{vi ? 'Đơn hôm nay/mai sẽ hiện ở đây.' : "Les commandes d'aujourd'hui/demain apparaîtront ici."}</p>
        </div>
      ) : (
        dates.map(d => (
          <div key={d}>
            <div className="text-xs font-bold uppercase tracking-wide text-ink-light mb-2 capitalize">{dayLabel(d)}</div>
            <div className="space-y-2">
              {byDate.get(d)!.map(o => {
                const validated = o.status === 'validated';
                const pct = o.total > 0 ? Math.round((o.checked / o.total) * 100) : 0;
                // order_ref can contain slashes (e.g. "REP/2026/00985") — a catch-all route
                // captures them as separate segments, so no encoding here.
                return (
                  <Link key={o.order_ref} href={`/delivery-check/${o.delivery_date}/${o.order_ref}`}
                    className="card flex items-center justify-between px-4 py-3 hover:bg-cream/40 transition-colors">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-navy">{o.order_ref}</div>
                      <div className="text-xs text-ink-light truncate">{o.shop_name}</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {validated ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold" style={{ color: '#059669' }}>
                          <CheckCircle2 size={15} /> {vi ? 'đã xác nhận' : 'validé'}
                        </span>
                      ) : (
                        <span className="text-xs font-semibold rounded-full px-2.5 py-1"
                          style={{ backgroundColor: pct === 100 ? '#DCFCE7' : '#F3F4F6', color: pct === 100 ? '#166534' : '#6B7280' }}>
                          {o.checked}/{o.total || '?'}
                        </span>
                      )}
                      <ChevronRight size={18} className="text-ink-light" />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
