'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, History, ChevronRight, CheckCircle2, CheckCheck } from 'lucide-react';

type Row = {
  id: string; order_ref: string; delivery_date: string; shop_name: string; status: string;
  printed_at: string | null; odoo_push_status: string | null; checked: number; total: number;
};

export default function DeliveryCheckHistoryView({ orders, start, end }: { orders: Row[]; start: string; end: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  const byDate: Record<string, Row[]> = {};
  for (const o of orders) (byDate[o.delivery_date] ??= []).push(o);
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  return (
    <div className="space-y-4">
      <Link href="/delivery-check" className="inline-flex items-center gap-1.5 text-sm text-ink-light hover:text-navy">
        <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
      </Link>
      <div>
        <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy flex items-center gap-2">
          <History size={22} className="text-gold" /> {vi ? 'Lịch sử kiểm tra giao hàng' : 'Historique check livraison'}
        </h1>
        <p className="text-ink-light text-sm mt-0.5">
          {start} — {end} · {vi ? 'chỉ xem, không chỉnh sửa' : 'lecture seule'}
        </p>
      </div>

      {dates.length === 0 ? (
        <div className="card p-10 text-center text-sm text-ink-light">
          {vi ? 'Không có đơn nào trong 7 ngày qua' : 'Aucune commande sur les 7 derniers jours'}
        </div>
      ) : (
        dates.map(date => (
          <div key={date} className="space-y-2">
            <h2 className="text-sm font-bold text-navy uppercase tracking-wide">{date}</h2>
            <div className="space-y-1.5">
              {byDate[date].map(o => {
                const validated = o.status === 'validated';
                const odooDone = o.odoo_push_status === 'validated' || o.odoo_push_status === 'already_done';
                const bg = odooDone ? '#FFFBEB' : validated ? '#F0FDF4' : undefined;
                const border = odooDone ? '#FDE68A' : validated ? '#BBF7D0' : '#E5E7EB';
                return (
                  <Link key={o.id} href={`/delivery-check/${o.delivery_date}/${o.order_ref}`}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl"
                    style={{ backgroundColor: bg, border: `1px solid ${border}` }}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-navy">{o.order_ref}</div>
                      <div className="text-xs text-ink-light truncate">{o.shop_name}</div>
                    </div>
                    {odooDone ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold shrink-0" style={{ color: '#92400E' }}>
                        <CheckCheck size={14} /> 100%
                      </span>
                    ) : validated ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold shrink-0" style={{ color: '#059669' }}>
                        <CheckCircle2 size={14} /> {vi ? 'đã xác nhận' : 'validé'}
                      </span>
                    ) : (
                      <span className="text-xs font-semibold shrink-0" style={{ color: '#6B7280' }}>{o.checked}/{o.total || '?'}</span>
                    )}
                    <ChevronRight size={16} className="text-ink-light shrink-0" />
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
