'use client';
// REP receptions the shop fully confirmed in the app whose shop IN is still open on Odoo (Axel,
// 2026-10-20: two of them were invisible — their gap had closed itself after a correction).
// Conforming ones are retried automatically every hour; this panel shows what is left.
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import { getStuckShopInsAction, retryShopInAction } from './actions';
import type { StuckShopIn } from '@/lib/reception-auto-in';

const REASON: Record<string, { vi: string; fr: string }> = {
  needs_lab_check: { vi: 'có lệch — xử lý ở các tab bên dưới', fr: 'gap — handle it in the tabs below' },
  no_shop_in: { vi: 'chưa có phiếu nhập trên Odoo', fr: 'no Odoo receipt yet' },
  lab_out_not_validated: { vi: 'Lab chưa xác nhận xuất kho trên Odoo', fr: 'Lab out not validated in Odoo' },
};

export default function StuckInPanel() {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [items, setItems] = useState<StuckShopIn[] | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => getStuckShopInsAction().then(r => { setItems(r.items ?? []); setCanRetry(!!r.canRetry); });
  useEffect(() => { load(); }, []);
  if (!items?.length) return null;
  const reason = (e: string | null) => {
    if (!e) return '';
    const k = Object.keys(REASON).find(k => e.startsWith(k));
    if (k) return vi ? REASON[k].vi : REASON[k].fr;
    if (e.startsWith('over_lab_out:')) return vi ? `shop nhận nhiều hơn Lab xuất trên Odoo (${e.split(':')[1]})` : `received > Lab out in Odoo (${e.split(':')[1]})`;
    return e;
  };
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #FCA5A5', backgroundColor: '#fff' }}>
      <div className="px-4 py-2.5 text-sm font-bold flex items-center gap-2" style={{ backgroundColor: '#FEF2F2', color: '#991B1B' }}>
        <AlertTriangle size={16} /> {vi ? `Shop đã nhận đủ · Odoo chưa xác nhận nhập kho · ${items.length}` : `Received by the shop · Odoo receipt not validated · ${items.length}`}
      </div>
      {items.map(s => (
        <div key={s.deliveryOrderId} className="px-4 py-2 flex items-center gap-3 text-[13px]" style={{ borderTop: '1px solid #FDE2E2' }}>
          <div className="flex-1 min-w-0">
            <b>{s.orderRef}</b> · {s.shopName.replace(/^La Paris\s*/, '')} · {s.deliveryDate.slice(8, 10)}/{s.deliveryDate.slice(5, 7)} · <span style={{ color: '#6B7280' }}>{s.inName}</span>
            <div className="text-[11.5px]" style={{ color: '#B45309' }}>{s.conforming ? (vi ? 'Đủ số — ' : 'Matches — ') : ''}{reason(s.lastError)}</div>
          </div>
          {canRetry && s.conforming && (
            <button disabled={!!busy} onClick={async () => {
              setBusy(s.deliveryOrderId); setMsg(null);
              const r = await retryShopInAction(s.deliveryOrderId, s.orderRef);
              setBusy(null);
              setMsg(r.error ?? `${s.orderRef}: ${r.outcome}${r.detail ? ` (${reason(r.detail)})` : ''}`);
              load();
            }} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold text-white" style={{ backgroundColor: '#1F2A44' }}>
              {busy === s.deliveryOrderId ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} {vi ? 'Xác nhận Odoo' : 'Validate in Odoo'}
            </button>
          )}
        </div>
      ))}
      {msg && <div className="px-4 py-1.5 text-xs" style={{ color: '#374151', borderTop: '1px solid #FDE2E2' }}>{msg}</div>}
    </div>
  );
}
