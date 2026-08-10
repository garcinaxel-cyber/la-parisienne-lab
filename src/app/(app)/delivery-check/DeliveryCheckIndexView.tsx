'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ClipboardCheck, ChevronRight, CircleAlert, CheckCircle2, LayoutGrid } from 'lucide-react';

type OrderRow = {
  order_ref: string; delivery_date: string; shop_name: string;
  status: string; checked: number; total: number;
};

export default function DeliveryCheckIndexView({ today, tomorrow, orders, pendingCakesCount }: {
  today: string; tomorrow: string; orders: OrderRow[]; pendingCakesCount: number;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const searchParams = useSearchParams();
  // Day selection lives in the URL (?day=tomorrow), not local state — an assistant who taps
  // "Demain", opens an order, then goes back was landing back on "Aujourd'hui" because the
  // page remounted with useState's default. Reading it from the URL means both a real browser
  // back-navigation and the order page's own "Retour" link (which sets ?day= explicitly) land
  // on the right tab (2026-08-10).
  const day: 'today' | 'tomorrow' = searchParams.get('day') === 'tomorrow' ? 'tomorrow' : 'today';
  const setDay = (d: 'today' | 'tomorrow') => router.replace(d === 'today' ? '/delivery-check' : '/delivery-check?day=tomorrow', { scroll: false });
  const activeDate = day === 'today' ? today : tomorrow;
  const dayOrders = orders.filter(o => o.delivery_date === activeDate);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
          <ClipboardCheck size={24} /> {vi ? 'Kiểm tra giao hàng' : 'Check livraison'}
        </h1>
        <p className="text-ink-light text-sm mt-0.5">
          {vi ? 'Kiểm số lượng theo đơn, điều chỉnh nếu cần, sau đó xác nhận.' : 'Vérifier la quantité par commande, ajuster si besoin, puis valider.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <Link href="/delivery-check/category"
          className="flex items-center gap-3 rounded-xl px-4 py-3.5"
          style={{ backgroundColor: '#1f2937' }}>
          <LayoutGrid size={20} className="text-white shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-white">{vi ? 'Kiểm theo loại sản phẩm' : 'Check par catégorie'}</div>
            <div className="text-xs" style={{ color: '#D1D5DB' }}>
              {vi ? 'Macaron, Viennoiserie, Savory...' : 'Macaron, Viennoiserie, Savory...'}
            </div>
          </div>
          <ChevronRight size={18} className="shrink-0" style={{ color: '#9CA3AF' }} />
        </Link>

        <Link href="/delivery-check/unreconciled"
          className="flex items-center gap-3 rounded-xl px-4 py-3.5"
          style={{ backgroundColor: pendingCakesCount > 0 ? '#DC2626' : '#F3F4F6' }}>
          <CircleAlert size={20} className="shrink-0" style={{ color: pendingCakesCount > 0 ? 'white' : '#9CA3AF' }} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold" style={{ color: pendingCakesCount > 0 ? 'white' : '#6B7280' }}>
              {pendingCakesCount > 0
                ? `${pendingCakesCount} ${vi ? 'chưa đồng bộ Odoo' : 'non conciliés Odoo'}`
                : (vi ? 'Tất cả đã đồng bộ' : 'Tout est concilié')}
            </div>
            <div className="text-xs" style={{ color: pendingCakesCount > 0 ? '#FECACA' : '#9CA3AF' }}>
              {vi ? 'Bánh chưa có đơn Odoo' : 'Cakes sans commande Odoo'}
            </div>
          </div>
          <ChevronRight size={18} className="shrink-0" style={{ color: pendingCakesCount > 0 ? '#FECACA' : '#9CA3AF' }} />
        </Link>
      </div>

      <div className="flex gap-1.5">
        {(['today', 'tomorrow'] as const).map(d => (
          <button key={d} onClick={() => setDay(d)}
            className="text-xs font-semibold rounded-full px-3.5 py-1.5"
            style={{
              border: '1px solid', borderColor: day === d ? '#1f2937' : '#D1D5DB',
              backgroundColor: day === d ? '#F3F4F6' : 'transparent', color: '#1f2937',
            }}>
            {d === 'today' ? (vi ? 'Hôm nay' : "Aujourd'hui") : (vi ? 'Ngày mai' : 'Demain')}
          </button>
        ))}
      </div>

      {dayOrders.length === 0 ? (
        <div className="card p-10 text-center">
          <ClipboardCheck size={44} className="mx-auto mb-3 text-green-600" />
          <p className="font-semibold text-navy">{vi ? 'Không có đơn nào' : 'Aucune commande'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {dayOrders.map(o => {
            const validated = o.status === 'validated';
            const full = o.total > 0 && o.checked === o.total;
            const dotColor = validated || full ? '#16A34A' : o.checked > 0 ? '#D97706' : '#9CA3AF';
            const bg = validated || full ? '#F0FDF4' : undefined;
            const border = validated || full ? '#BBF7D0' : '#E5E7EB';
            return (
              // order_ref can contain slashes (e.g. "REP/2026/00985") — a catch-all route
              // captures them as separate segments, so no encoding here.
              <Link key={o.order_ref} href={`/delivery-check/${o.delivery_date}/${o.order_ref}`}
                className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors"
                style={{ backgroundColor: bg, border: `1px solid ${border}` }}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-navy">{o.order_ref}</div>
                  <div className="text-xs text-ink-light truncate">{o.shop_name}</div>
                </div>
                {validated ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold shrink-0" style={{ color: '#059669' }}>
                    <CheckCircle2 size={15} /> {vi ? 'đã xác nhận' : 'validé'}
                  </span>
                ) : (
                  <span className="text-xs font-semibold shrink-0" style={{ color: full ? '#166534' : '#6B7280' }}>
                    {o.checked}/{o.total || '?'}
                  </span>
                )}
                <ChevronRight size={18} className="text-ink-light shrink-0" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
