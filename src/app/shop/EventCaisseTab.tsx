'use client';
import { useEffect, useState } from 'react';
import { Minus, Plus, CheckCircle2, Loader2 } from 'lucide-react';
import { getEventCaisseCatalogAction, recordEventSaleAction, getEventSalesHistoryAction, type EventCaisseProduct, type EventSaleHistoryLine } from './actions';
import { NAVY, GOLD, GOLD_PALE, INK, BORDER, GREEN, RED } from './ShopView';

// "Thu ngân" — the event's mini cash register (Axel, 2026-09-12): "une sorte de mini caisse
// enregistreuse qui n'aurait aucun impact odoo". Standalone tab, same self-fetching pattern as
// ShopTransfersTab — everything it needs comes from its own three actions, gated server-side to
// whichever event the current PIN session points to (see requireEventSession in shop/actions.ts).
// Can only ever sell what the event's own latest stock count still has on hand minus what this
// tab has already sold (Axel's locked-in answer: "uniquement ce qui a été livré/compté sur
// l'event") — the server re-checks this on submit too, the client-side clamp here is just UX.

function fmt(v: number): string {
  return v.toLocaleString('vi-VN') + ' ₫';
}

export default function EventCaisseTab() {
  const [products, setProducts] = useState<EventCaisseProduct[] | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<EventSaleHistoryLine[] | null>(null);

  async function load() {
    const [p, h] = await Promise.all([getEventCaisseCatalogAction(), getEventSalesHistoryAction()]);
    setProducts(p.products ?? []);
    setHistory(h.sales ?? []);
  }
  useEffect(() => { load(); }, []);

  function changeQty(sku: string, delta: number, max: number) {
    setCart(c => {
      const next = Math.max(0, Math.min(max, (c[sku] ?? 0) + delta));
      return { ...c, [sku]: next };
    });
  }

  const total = Object.entries(cart).reduce((sum, [sku, qty]) => {
    const p = products?.find(x => x.sku === sku);
    return sum + qty * (p?.unitPrice ?? 0);
  }, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  async function confirmSale() {
    setSubmitting(true);
    setMsg(null);
    const items = Object.entries(cart).filter(([, qty]) => qty > 0).map(([sku, qty]) => ({ sku, qty }));
    const res = await recordEventSaleAction(items);
    setSubmitting(false);
    if (res.error) { setMsg(res.error); return; }
    setCart({});
    setMsg('✓ Đã ghi nhận bán hàng (không ảnh hưởng Odoo)');
    load();
  }

  if (!products) return <div className="text-center py-10 text-sm" style={{ color: '#6B7280' }}>Đang tải…</div>;

  return (
    <div className="space-y-3 pb-20">
      <div className="rounded-xl px-3.5 py-2.5 text-xs font-semibold" style={{ backgroundColor: GOLD_PALE, border: `1px solid ${GOLD}`, color: '#8A6D14' }}>
        📦 Chỉ hiện sản phẩm đã nhập/kiểm kho tại event — không thể bán quá số thực có.
      </div>

      {!products.length ? (
        <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>
          Chưa có sản phẩm nào để bán — kiểm kho trước ở tab &quot;Kiểm kho&quot;.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {products.map(p => {
            const qty = cart[p.sku] ?? 0;
            const remaining = p.available - qty;
            return (
              <div key={p.sku} className="bg-white rounded-2xl p-3" style={{ border: `1px solid ${BORDER}` }}>
                <div className="text-[13px] font-bold leading-tight" style={{ color: INK }}>{p.name}</div>
                <div className="text-[10.5px] mt-0.5" style={{ color: '#9CA3AF' }}>Còn <b>{remaining}</b></div>
                <div className="text-xs font-extrabold mt-1" style={{ color: '#8A6D14' }}>{fmt(p.unitPrice)}</div>
                <div className="flex items-center justify-between mt-2 rounded-lg px-1.5 py-1" style={{ backgroundColor: GOLD_PALE }}>
                  <button onClick={() => changeQty(p.sku, -1, p.available)} className="w-7 h-7 rounded-md text-white font-bold flex items-center justify-center" style={{ backgroundColor: NAVY }}>
                    <Minus size={14} />
                  </button>
                  <span className="text-sm font-extrabold tabular-nums">{qty}</span>
                  <button onClick={() => changeQty(p.sku, 1, p.available)} disabled={remaining <= 0} className="w-7 h-7 rounded-md text-white font-bold flex items-center justify-center disabled:opacity-40" style={{ backgroundColor: NAVY }}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {msg && (
        <div className="text-xs font-semibold text-center rounded-lg px-3 py-2" style={{ backgroundColor: msg.startsWith('✓') ? '#EAF6EC' : '#FBEAE8', color: msg.startsWith('✓') ? GREEN : RED }}>
          {msg}
        </div>
      )}

      {history && history.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Đã bán · {history.length}</div>
          {history.map((s, i) => (
            <div key={i} className="flex items-center justify-between bg-white rounded-xl px-3 py-2" style={{ border: '1px solid #F0EAC6' }}>
              <div>
                <div className="text-xs font-bold" style={{ color: INK }}>{s.label}</div>
                <div className="text-[10px]" style={{ color: '#9CA3AF' }}>{s.time}</div>
              </div>
              <div className="text-xs font-extrabold" style={{ color: GREEN }}>+{fmt(s.amount)}</div>
            </div>
          ))}
        </div>
      )}

      {cartCount > 0 && (
        <div className="fixed left-0 right-0 bottom-0 px-4 py-3 flex items-center justify-between gap-3" style={{ backgroundColor: '#1A4731' }}>
          <div className="max-w-xl mx-auto w-full flex items-center justify-between gap-3">
            <div>
              <div className="text-[9.5px] uppercase tracking-wide font-bold" style={{ color: '#F0D98A' }}>Tổng đơn</div>
              <div className="text-base font-extrabold tabular-nums" style={{ color: '#FFFAEE' }}>{fmt(total)}</div>
            </div>
            <button onClick={confirmSale} disabled={submitting}
              className="inline-flex items-center gap-1.5 text-sm font-extrabold rounded-xl px-4 py-2.5 disabled:opacity-60"
              style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              Xác nhận bán
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
