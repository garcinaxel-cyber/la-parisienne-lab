'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useRealtimeRefresh } from '@/lib/useRealtimeRefresh';
import { ClipboardList, Users, FileText, CheckCircle2, Store, User } from 'lucide-react';
import Link from 'next/link';
import OrderReviewView from './OrderReviewView';
import OrdersCommandView from './OrdersCommandView';
import PublishBar from './PublishBar';

type ManualMatch = {
  manualId: string; name: string; qty: number; sku: string;
  source: string; fromShop: boolean; suggestedRef: string; suggestedShop: string | null;
};

// Two views over the same data:
//  - "By order"  : the assistants' cockpit (one row per client order, Odoo status + production progress)
//  - "By team"   : the original review view (kept unchanged)
export default function OrdersTabs(props: {
  date: string;
  imports: any[];
  assignments: any[];
  orderLines: any[];
  unmatchedProducts: { sku: string; name: string; qty: number }[];
  missingCardsCount: number;
  missingCards: { name: string; team: string; qty: number }[];
  producedManually?: string[];
  manualMatches?: ManualMatch[];
  openManualNoMatch?: number;
  userRole: string | null;
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const [view, setView] = useState<'orders' | 'teams'>('orders');
  const [matchBusy, setMatchBusy] = useState<string | null>(null);
  const canManage = ['admin', 'lab_manager', 'assistant'].includes(props.userRole ?? '');
  const vi = lang === 'vi';
  const manualMatches = props.manualMatches ?? [];

  async function confirmManualMatch(m: ManualMatch) {
    setMatchBusy(m.manualId);
    const { confirmMatchAction } = await import('../../birthday-cakes/actions');
    await confirmMatchAction(m.manualId, m.suggestedRef, m.sku);
    setMatchBusy(null); router.refresh();
  }
  async function rejectManualMatch(m: ManualMatch) {
    setMatchBusy(m.manualId);
    const { rejectMatchAction } = await import('../../birthday-cakes/actions');
    await rejectMatchAction(m.manualId, m.suggestedRef);
    setMatchBusy(null); router.refresh();
  }
  // Live updates: refresh when an order/card for any day changes (new import, publish, status).
  useRealtimeRefresh(`orders-${props.date}`, [
    { table: 'lab_imports' },
    { table: 'lab_order_lines' },
    { table: 'lab_assignments' },
    { table: 'lab_manual_cakes' }, // a shop submission must surface in the match panel live
  ]);

  return (
    <div className="space-y-4">
      {/* Publish + unmatched-products bar — shared across both views */}
      <PublishBar date={props.date} imports={props.imports} orderLines={props.orderLines}
        unmatchedProducts={props.unmatchedProducts}
        missingCardsCount={props.missingCardsCount} missingCards={props.missingCards} canManage={canManage} />

      {/* Duplicate detection — manual (exceptional) orders that look like they ARE one of
          this day's Odoo orders. Linking here removes the Odoo duplicate from production. */}
      {canManage && manualMatches.length > 0 && (
        <div className="rounded-xl p-3.5 space-y-2.5" style={{ backgroundColor: '#FFFBEB', border: '1px solid #FCD34D' }}>
          <div className="flex items-center gap-2 text-sm font-bold" style={{ color: '#92600A' }}>
            <FileText size={16} />
            {vi
              ? `${manualMatches.length} đơn thủ công có thể trùng với đơn Odoo ngày này`
              : `${manualMatches.length} manual order${manualMatches.length > 1 ? 's' : ''} may match an Odoo order of this day`}
          </div>
          {manualMatches.map(m => (
            <div key={m.manualId} className="rounded-lg bg-white px-3 py-2.5 flex items-center gap-2 flex-wrap" style={{ border: '1px solid #FDE68A' }}>
              <span className="text-sm flex-1 min-w-[220px]" style={{ color: '#1A4731' }}>
                <span className="font-semibold">×{m.qty} · {m.name}</span>
                <span className="text-xs ml-2 inline-flex items-center gap-1" style={{ color: '#6B7280' }}>
                  {m.fromShop ? <Store size={11} /> : <User size={11} />}{m.source}
                </span>
                <span className="text-xs block mt-0.5" style={{ color: '#92600A' }}>
                  {vi ? 'Trùng SKU + ngày với' : 'Same SKU + date as'} <span className="font-mono font-bold">{m.suggestedRef}</span>{m.suggestedShop ? ` · ${m.suggestedShop}` : ''}
                </span>
              </span>
              <button onClick={() => confirmManualMatch(m)} disabled={matchBusy === m.manualId}
                className="text-xs font-bold px-3 py-1.5 rounded-full text-white inline-flex items-center gap-1 disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                <CheckCircle2 size={13} /> {matchBusy === m.manualId ? '…' : (vi ? 'Là đơn này — liên kết' : 'Same order — link')}
              </button>
              <button onClick={() => rejectManualMatch(m)} disabled={matchBusy === m.manualId}
                className="text-xs font-semibold px-3 py-1.5 rounded-full border disabled:opacity-40" style={{ borderColor: '#FCD34D', color: '#92600A' }}>
                {matchBusy === m.manualId ? '…' : (vi ? 'Không phải' : 'Not this one')}
              </button>
            </div>
          ))}
          {(props.openManualNoMatch ?? 0) > 0 && (
            <Link href="/exceptional-orders" className="text-xs font-medium inline-block" style={{ color: '#92600A' }}>
              {vi
                ? `+ ${props.openManualNoMatch} đơn thủ công khác chưa có gợi ý — xem Đơn đặc biệt →`
                : `+ ${props.openManualNoMatch} other manual order${(props.openManualNoMatch ?? 0) > 1 ? 's' : ''} with no suggestion yet — see Exceptional orders →`}
            </Link>
          )}
        </div>
      )}

      <div className="flex gap-1 border-b border-border-soft">
        {[
          { key: 'orders' as const, icon: ClipboardList, label: lang === 'vi' ? 'Theo đơn hàng' : 'By order' },
          { key: 'teams' as const, icon: Users, label: lang === 'vi' ? 'Theo đội / chi tiết' : 'By team / detail' },
        ].map(t => (
          <button key={t.key} onClick={() => setView(t.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors -mb-px flex items-center gap-2 ${
              view === t.key
                ? 'bg-white border border-border-soft border-b-white text-navy'
                : 'text-ink-light hover:text-navy'
            }`}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      {view === 'orders'
        ? <OrdersCommandView {...props} />
        : <OrderReviewView {...props} />}
    </div>
  );
}
