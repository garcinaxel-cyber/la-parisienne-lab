'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ClipboardCheck, ChevronRight, CircleAlert, CheckCircle2, CheckCheck, LayoutGrid, Printer, AlertTriangle, ChevronDown, CalendarDays, History, MapPin } from 'lucide-react';

type OrderRow = {
  order_ref: string; delivery_date: string; shop_name: string;
  status: string; checked: number; total: number; printed_at: string | null;
  odoo_push_status: string | null;
};

type SyncGap = { order_ref: string; source_type: string; delivery_date: string | null; reason: string };
// Date reassigned in Odoo after import (2026-08-12, S03188/KAFEBEAN) — see odoo-sync.ts's
// OdooSyncResult.dateChanges doc comment for why this is flag-only, not auto-corrected.
type DateAlert = { order_ref: string; source_type: string; old_date: string; new_date: string };

const GAP_REASON_LABEL: Record<string, { vi: string; fr: string }> = {
  all_lines_excluded_sku_no_fallback_yet: { vi: 'chỉ có bao bì, chưa hỗ trợ cho sales order', fr: 'que du packaging, pas encore géré côté sales order' },
  all_lines_excluded: { vi: 'chỉ có bao bì', fr: 'que du packaging' },
  no_lines_in_odoo: { vi: 'không có dòng sản phẩm trên Odoo', fr: "aucune ligne produit sur Odoo" },
  unmatched_sku_or_zero_qty: { vi: 'SKU không khớp hoặc số lượng = 0', fr: 'SKU non reconnu ou quantité = 0' },
};

export default function DeliveryCheckIndexView({ today, tomorrow, orders, pendingCakesCount, syncGaps, dateAlerts }: {
  today: string; tomorrow: string; orders: OrderRow[]; pendingCakesCount: number; syncGaps: SyncGap[]; dateAlerts: DateAlert[];
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [gapsOpen, setGapsOpen] = useState(false);
  const [dateAlertsOpen, setDateAlertsOpen] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  // Day selection lives in the URL (?day=tomorrow), not local state — an assistant who taps
  // "Demain", opens an order, then goes back was landing back on "Aujourd'hui" because the
  // page remounted with useState's default. Reading it from the URL means both a real browser
  // back-navigation and the order page's own "Retour" link (which sets ?day= explicitly) land
  // on the right tab (2026-08-10).
  const dayParam = searchParams.get('day');
  const day: 'today' | 'tomorrow' | 'late' = dayParam === 'tomorrow' ? 'tomorrow' : dayParam === 'late' ? 'late' : 'today';
  const setDay = (d: 'today' | 'tomorrow' | 'late') =>
    router.replace(d === 'today' ? '/delivery-check' : `/delivery-check?day=${d}`, { scroll: false });
  const activeDate = day === 'today' ? today : tomorrow;
  // "Late" = anything strictly before today still surfaced by the widened sync window (2026-08-26,
  // Axel: a manual/exceptional cake formalized into a real Odoo order a day+ after its own
  // delivery_date) — kept in its own tab rather than merged into "Aujourd'hui" since mixing
  // several different dates in one list would be confusing.
  const lateOrders = orders.filter(o => o.delivery_date < today);
  const dayOrders = day === 'late' ? lateOrders : orders.filter(o => o.delivery_date === activeDate);

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

      {syncGaps.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #FCA5A5', backgroundColor: '#FEF2F2' }}>
          <button onClick={() => setGapsOpen(o => !o)} className="w-full flex items-center gap-2.5 px-4 py-3 text-left">
            <AlertTriangle size={18} className="shrink-0" style={{ color: '#DC2626' }} />
            <span className="flex-1 text-sm font-bold" style={{ color: '#991B1B' }}>
              {syncGaps.length} {vi ? 'đơn Odoo có thể chưa hiện ở đây' : 'commande(s) Odoo peut-être invisible(s) ici'}
            </span>
            <ChevronDown size={16} className="shrink-0 transition-transform" style={{ color: '#DC2626', transform: gapsOpen ? 'rotate(180deg)' : undefined }} />
          </button>
          {gapsOpen && (
            <div className="px-4 pb-3 space-y-1.5">
              {syncGaps.map(g => {
                const label = GAP_REASON_LABEL[g.reason];
                return (
                  <div key={g.order_ref} className="text-xs flex items-center justify-between gap-2" style={{ color: '#991B1B' }}>
                    <span className="font-mono font-semibold">{g.order_ref}</span>
                    <span className="text-right">{label ? (vi ? label.vi : label.fr) : g.reason}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {dateAlerts.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #FCD34D', backgroundColor: '#FFFBEB' }}>
          <button onClick={() => setDateAlertsOpen(o => !o)} className="w-full flex items-center gap-2.5 px-4 py-3 text-left">
            <CalendarDays size={18} className="shrink-0" style={{ color: '#B45309' }} />
            <span className="flex-1 text-sm font-bold" style={{ color: '#92400E' }}>
              {dateAlerts.length} {vi ? 'đơn đã đổi ngày trên Odoo — cần sửa tay' : 'commande(s) déplacée(s) sur Odoo — à corriger à la main'}
            </span>
            <ChevronDown size={16} className="shrink-0 transition-transform" style={{ color: '#B45309', transform: dateAlertsOpen ? 'rotate(180deg)' : undefined }} />
          </button>
          {dateAlertsOpen && (
            <div className="px-4 pb-3 space-y-1.5">
              {dateAlerts.map(d => (
                <div key={d.order_ref} className="text-xs flex items-center justify-between gap-2" style={{ color: '#92400E' }}>
                  <span className="font-mono font-semibold">{d.order_ref}</span>
                  <span className="text-right">{d.old_date} → {d.new_date}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
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

        <Link href="/delivery-check/by-shop"
          className="flex items-center gap-3 rounded-xl px-4 py-3.5"
          style={{ backgroundColor: '#1f2937' }}>
          <MapPin size={20} className="text-white shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-white">{vi ? 'Theo nơi giao hàng' : 'Par lieu de livraison'}</div>
            <div className="text-xs" style={{ color: '#D1D5DB' }}>
              {vi ? 'Phát hiện đơn ghi 1 shop, giao shop khác' : 'Repère les écarts shop prévu / shop livré'}
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

      <div className="flex items-center justify-between gap-2">
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
          {lateOrders.length > 0 && (
            <button onClick={() => setDay('late')}
              className="text-xs font-bold rounded-full px-3.5 py-1.5 inline-flex items-center gap-1"
              style={{
                border: '1px solid', borderColor: day === 'late' ? '#B45309' : '#FCD34D',
                backgroundColor: day === 'late' ? '#FEF3C7' : '#FFFBEB', color: '#92400E',
              }}>
              <AlertTriangle size={12} /> {vi ? `Trễ (${lateOrders.length})` : `En retard (${lateOrders.length})`}
            </button>
          )}
        </div>
        <Link href="/delivery-check/history"
          className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-3.5 py-1.5 shrink-0"
          style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
          <History size={13} /> {vi ? 'Lịch sử' : 'Historique'}
        </Link>
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
            // Odoo delivery validation (Axel, 2026-08-17) — the strongest signal, takes priority
            // over the checklist-only "validé": that one just means every line was checked in the
            // app, this one means it's actually been written back to Odoo. Distinct gold tint so
            // it's never confused with plain checklist-validated at a glance.
            const odooDone = o.odoo_push_status === 'validated' || o.odoo_push_status === 'already_done';
            const dotColor = odooDone ? '#D97706' : validated || full ? '#16A34A' : o.checked > 0 ? '#D97706' : '#9CA3AF';
            // Printed gets its own light-blue tint when nothing stronger (validated/full) applies —
            // a quick visual "already printed, don't reprint" cue on top of the existing progress dot.
            const bg = odooDone ? '#FFFBEB' : validated || full ? '#F0FDF4' : o.printed_at ? '#EFF6FF' : undefined;
            const border = odooDone ? '#FDE68A' : validated || full ? '#BBF7D0' : o.printed_at ? '#BFDBFE' : '#E5E7EB';
            return (
              // order_ref can contain slashes (e.g. "REP/2026/00985") — a catch-all route
              // captures them as separate segments, so no encoding here.
              <Link key={o.order_ref} href={`/delivery-check/${o.delivery_date}/${o.order_ref}`}
                className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors"
                style={{ backgroundColor: bg, border: `1px solid ${border}` }}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-navy flex items-center gap-1.5">
                    {o.order_ref}
                    {o.printed_at && (
                      <span title={vi ? 'Đã in' : 'Déjà imprimé'}>
                        <Printer size={12} style={{ color: '#2563EB' }} />
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ink-light truncate flex items-center gap-1.5">
                    {o.shop_name}
                    {/* Several different dates mixed in this tab — show which one per row */}
                    {day === 'late' && (
                      <span className="font-mono font-semibold shrink-0" style={{ color: '#B45309' }}>· {o.delivery_date}</span>
                    )}
                  </div>
                </div>
                {odooDone ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold shrink-0" style={{ color: '#92400E' }}>
                    <CheckCheck size={15} /> {vi ? '100%' : '100%'}
                  </span>
                ) : validated ? (
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
