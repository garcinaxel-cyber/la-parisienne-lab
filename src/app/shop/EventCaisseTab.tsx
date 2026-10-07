'use client';
import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, CheckCircle2, Loader2, Banknote, QrCode, ArrowLeft, Gift, Search, Cake, ChevronDown, ChevronUp } from 'lucide-react';
import { getEventCaisseCatalogAction, recordEventSaleAction, getEventSalesHistoryAction, getEventSalesSummaryAction, type EventCaisseProduct, type EventSaleHistoryLine, type EventSalesSummary } from './actions';
import { NAVY, GOLD, GOLD_PALE, INK, BORDER, GREEN, RED } from './ShopView';
import { useShopL } from './shop-lang';

// "Thu ngân" — the event's mini cash register (Axel, 2026-09-12): "une sorte de mini caisse
// enregistreuse qui n'aurait aucun impact odoo". Standalone tab, same self-fetching pattern as
// ShopTransfersTab — everything it needs comes from its own three actions, gated server-side to
// whichever event the current PIN session points to (see requireEventSession in shop/actions.ts).
// Sells whatever was sent to the event through its replenishment orders (REP). "Còn" is what
// the book says is left; it is information only — a sale is never refused on stock, even at zero
// or below (Axel, 2026-10-07: "ils auraient sûrement mal compté").
//
// Promo (Axel, 2026-09-14): "buy one get one free, buy 2 get one free ... buy 5 macaron get one
// free" — no rule config, staff just decides at the till. freeCart mirrors cart 1:1 (sku -> how
// many of the units already in the cart are free) — see recordEventSaleAction for why this is
// enough to cover any "buy X get 1 free" shape without knowing categories or rules server-side.
//
// Payment method + QR (Axel, 2026-09-14): "je voudrais la possibilite de dire si c'est vendu via
// cash ou transfert et si c'est transfert que ca affiche une picture du QR code de paiement que
// l'on met nous meme avant que l'event commence" — a 2-button chooser on "Xác nhận bán", QR shown
// (event.qrCodeUrl, uploaded by admin ahead of time — EventsAdminView) only for "transfer".

function fmt(v: number): string {
  return v.toLocaleString('vi-VN') + ' ₫';
}

export default function EventCaisseTab() {
  const L = useShopL();
  const [products, setProducts] = useState<EventCaisseProduct[] | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [freeCart, setFreeCart] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<EventSaleHistoryLine[] | null>(null);
  const [summary, setSummary] = useState<EventSalesSummary | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  // Axel, 2026-09-14: "un filtre par nom et aussi par categorie" — name search + category pills
  // over the product grid; category comes from the fiche (see getEventCaisseCatalogAction).
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // 'idle' = cart view; 'choosing' = pick cash/transfer; 'transferQr' = showing the QR to confirm.
  const [paymentStep, setPaymentStep] = useState<'idle' | 'choosing' | 'transferQr'>('idle');

  async function load() {
    const [p, h, s] = await Promise.all([getEventCaisseCatalogAction(), getEventSalesHistoryAction(), getEventSalesSummaryAction()]);
    setProducts(p.products ?? []);
    setQrCodeUrl(p.qrCodeUrl ?? null);
    setHistory(h.sales ?? []);
    setSummary(s.summary ?? null);
  }
  useEffect(() => { load(); }, []);

  const categories = useMemo(
    () => Array.from(new Set((products ?? []).map(p => p.category).filter((c): c is string => !!c))).sort((a, b) => a.localeCompare(b)),
    [products],
  );
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? []).filter(p =>
      (!q || p.name.toLowerCase().includes(q)) && (!categoryFilter || p.category === categoryFilter),
    );
  }, [products, search, categoryFilter]);

  function changeQty(sku: string, delta: number) {
    const next = Math.max(0, Math.min(999, (cart[sku] ?? 0) + delta));
    setCart(c => ({ ...c, [sku]: next }));
    // A line dropping (or shrinking below its current free count) clamps freeCart along with it.
    setFreeCart(f => ((f[sku] ?? 0) > next ? { ...f, [sku]: next } : f));
  }
  function changeFree(sku: string, delta: number) {
    const qty = cart[sku] ?? 0;
    setFreeCart(f => ({ ...f, [sku]: Math.max(0, Math.min(qty, (f[sku] ?? 0) + delta)) }));
  }

  const total = Object.entries(cart).reduce((sum, [sku, qty]) => {
    const p = products?.find(x => x.sku === sku);
    const free = Math.min(freeCart[sku] ?? 0, qty);
    return sum + Math.max(0, qty - free) * (p?.unitPrice ?? 0);
  }, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const freeCount = Object.entries(freeCart).reduce((sum, [sku, f]) => sum + Math.min(f, cart[sku] ?? 0), 0);

  async function confirmSale(paymentMethod: 'cash' | 'transfer') {
    setSubmitting(true);
    setMsg(null);
    const items = Object.entries(cart).filter(([, qty]) => qty > 0)
      .map(([sku, qty]) => ({ sku, qty, freeQty: Math.min(freeCart[sku] ?? 0, qty) }));
    const res = await recordEventSaleAction(items, paymentMethod);
    setSubmitting(false);
    setPaymentStep('idle');
    if (res.error) { setMsg(res.error); return; }
    setCart({}); setFreeCart({});
    setMsg(L('✓ Đã ghi nhận bán hàng (không ảnh hưởng Odoo)', '✓ Sale recorded (no impact on Odoo)'));
    load();
  }

  if (!products) return <div className="text-center py-10 text-sm" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div>;

  return (
    <div className="space-y-3 pb-20">
      <div className="rounded-xl px-3.5 py-2.5 text-xs font-semibold" style={{ backgroundColor: GOLD_PALE, border: `1px solid ${GOLD}`, color: '#8A6D14' }}>
        {L('📦 Sản phẩm lấy từ các đơn hàng (REP) của event, kể cả khi chưa xác nhận nhận hàng. Vẫn bán được khi số tồn về 0 hoặc âm.', '📦 Products come from the event\'s orders (REP), even before they are confirmed as received. Selling stays possible at zero or below.')}
      </div>

      {!products.length ? (
        <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>
          {L('Chưa có sản phẩm nào để bán — event chưa có đơn hàng (REP) nào, hoặc Lab chưa đồng bộ xong (tối đa 15 phút).', 'Nothing to sell yet — the event has no order (REP) so far, or the Lab has not finished syncing (up to 15 minutes).')}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 rounded-xl px-3 py-2" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
            <Search size={14} style={{ color: '#9CA3AF', flexShrink: 0 }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={L('Tìm sản phẩm…', 'Search a product…')}
              className="flex-1 text-[13px]" style={{ border: 'none', outline: 'none', color: INK, background: 'transparent' }} />
          </div>
          {categories.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              <button onClick={() => setCategoryFilter(null)} className="flex-shrink-0 text-[11px] font-bold rounded-full px-3 py-1.5" style={{
                backgroundColor: categoryFilter === null ? NAVY : '#fff', color: categoryFilter === null ? '#FFFAEE' : INK,
                border: categoryFilter === null ? 'none' : `1px solid ${BORDER}`,
              }}>{L('Tất cả', 'All')}</button>
              {categories.map(c => (
                <button key={c} onClick={() => setCategoryFilter(c === categoryFilter ? null : c)} className="flex-shrink-0 text-[11px] font-bold rounded-full px-3 py-1.5" style={{
                  backgroundColor: categoryFilter === c ? NAVY : '#fff', color: categoryFilter === c ? '#FFFAEE' : INK,
                  border: categoryFilter === c ? 'none' : `1px solid ${BORDER}`,
                }}>{c}</button>
              ))}
            </div>
          )}
          {!filteredProducts.length && (
            <div className="text-center py-6 text-xs" style={{ color: '#9CA3AF' }}>{L('Không tìm thấy sản phẩm.', 'No product found.')}</div>
          )}
        <div className="grid grid-cols-2 gap-2.5">
          {filteredProducts.map(p => {
            const qty = cart[p.sku] ?? 0;
            const free = Math.min(freeCart[p.sku] ?? 0, qty);
            const remaining = p.available - qty;
            return (
              <div key={p.sku} className="bg-white rounded-2xl p-3" style={{ border: `1px solid ${BORDER}` }}>
                <div className="w-full aspect-square rounded-xl mb-2 flex items-center justify-center overflow-hidden" style={{ backgroundColor: GOLD_PALE }}>
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <Cake size={26} style={{ color: GOLD }} />
                  )}
                </div>
                <div className="text-[13px] font-bold leading-tight" style={{ color: INK }}>{p.name}</div>
                <div className="text-[10.5px] mt-0.5" style={{ color: remaining <= 0 ? RED : '#9CA3AF' }}>{L('Còn', 'Left')} <b>{remaining}</b></div>
                <div className="text-xs font-extrabold mt-1" style={{ color: '#8A6D14' }}>{fmt(p.unitPrice)}</div>
                <div className="flex items-center justify-between mt-2 rounded-lg px-1.5 py-1" style={{ backgroundColor: GOLD_PALE }}>
                  <button onClick={() => changeQty(p.sku, -1)} className="w-7 h-7 rounded-md text-white font-bold flex items-center justify-center" style={{ backgroundColor: NAVY }}>
                    <Minus size={14} />
                  </button>
                  <span className="text-sm font-extrabold tabular-nums">{qty}</span>
                  <button onClick={() => changeQty(p.sku, 1)} className="w-7 h-7 rounded-md text-white font-bold flex items-center justify-center" style={{ backgroundColor: NAVY }}>
                    <Plus size={14} />
                  </button>
                </div>
                {/* Promo (Axel, 2026-09-14): "buy X get 1 free" decided by staff at the till, no
                    rule config — this just marks how many of the units above are free. */}
                {qty > 0 && (
                  <div className="flex items-center justify-between mt-1.5 rounded-lg px-1.5 py-1" style={{ backgroundColor: free > 0 ? '#FEF3C7' : 'transparent' }}>
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold" style={{ color: free > 0 ? '#92600A' : '#9CA3AF' }}>
                      <Gift size={11} /> {L('Miễn phí', 'Free')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => changeFree(p.sku, -1)} disabled={free <= 0} className="w-5 h-5 rounded flex items-center justify-center disabled:opacity-30" style={{ backgroundColor: '#fff', border: '1px solid #E5C77A' }}>
                        <Minus size={10} />
                      </button>
                      <span className="text-xs font-extrabold tabular-nums" style={{ minWidth: 12, textAlign: 'center' }}>{free}</span>
                      <button onClick={() => changeFree(p.sku, 1)} disabled={free >= qty} className="w-5 h-5 rounded flex items-center justify-center disabled:opacity-30" style={{ backgroundColor: '#fff', border: '1px solid #E5C77A' }}>
                        <Plus size={10} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}

      {msg && (
        <div className="text-xs font-semibold text-center rounded-lg px-3 py-2" style={{ backgroundColor: msg.startsWith('✓') ? '#EAF6EC' : '#FBEAE8', color: msg.startsWith('✓') ? GREEN : RED }}>
          {msg}
        </div>
      )}

      {/* Sales summary (Axel, 2026-09-14): "le total sales et la repartition par produit" — sums
          EVERY sale ever recorded for this event (not just the last 50 the trace list below
          shows), broken down per product on request. */}
      {summary && summary.orderCount > 0 && (
        <div className="bg-white rounded-2xl p-3.5" style={{ border: `1px solid ${BORDER}` }}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{L('Tổng doanh thu event', 'Total event sales')}</div>
              <div className="text-lg font-extrabold tabular-nums" style={{ color: NAVY }}>{fmt(summary.totalRevenue)}</div>
              <div className="text-[11px] mt-0.5" style={{ color: '#6B7280' }}>
                {L('Tiền mặt', 'Cash')} <b style={{ color: INK }}>{fmt(summary.cashRevenue)}</b> · {L('Chuyển khoản', 'Bank transfer')} <b style={{ color: INK }}>{fmt(summary.transferRevenue)}</b> · {summary.orderCount} {L('đơn', 'sales')}
              </div>
            </div>
            <button onClick={() => setShowBreakdown(v => !v)}
              className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg px-2.5 py-1.5"
              style={{ backgroundColor: GOLD_PALE, color: '#8A6D14' }}>
              {L('Theo sản phẩm', 'By product')} {showBreakdown ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>
          {showBreakdown && (
            <div className="mt-2.5 pt-2.5 space-y-1.5" style={{ borderTop: `1px solid ${BORDER}` }}>
              {summary.byProduct.map(p => (
                <div key={p.sku} className="flex items-center justify-between gap-2 text-xs">
                  <span style={{ color: INK }}>{p.name} <span style={{ color: '#9CA3AF' }}>×{p.qty}</span></span>
                  <span className="font-bold tabular-nums flex-shrink-0" style={{ color: '#8A6D14' }}>{fmt(p.revenue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {history && history.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{L('Đã bán', 'Sold')} · {history.length}</div>
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

      {cartCount > 0 && paymentStep === 'idle' && (
        <div className="fixed left-0 right-0 bottom-0 px-4 py-3 flex items-center justify-between gap-3" style={{ backgroundColor: '#1A4731' }}>
          <div className="max-w-xl mx-auto w-full flex items-center justify-between gap-3">
            <div>
              <div className="text-[9.5px] uppercase tracking-wide font-bold" style={{ color: '#F0D98A' }}>
                {L('Tổng đơn', 'Sale total')}{freeCount > 0 ? ` · ${freeCount} ${L('miễn phí', 'free')}` : ''}
              </div>
              <div className="text-base font-extrabold tabular-nums" style={{ color: '#FFFAEE' }}>{fmt(total)}</div>
            </div>
            <button onClick={() => setPaymentStep('choosing')}
              className="inline-flex items-center gap-1.5 text-sm font-extrabold rounded-xl px-4 py-2.5"
              style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
              <CheckCircle2 size={14} />
              {L('Xác nhận bán', 'Confirm the sale')}
            </button>
          </div>
        </div>
      )}

      {/* Payment method (Axel, 2026-09-14): "dire si c'est vendu via cash ou transfert et si
          transfert afficher le QR code". Full-screen sheet over the cart, same fixed-bottom-bar
          pattern as above. */}
      {paymentStep === 'choosing' && (
        <div className="fixed inset-0 z-10 flex flex-col justify-end" style={{ backgroundColor: 'rgba(26,71,49,0.55)' }} onClick={() => setPaymentStep('idle')}>
          <div className="bg-white rounded-t-2xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-[10.5px] uppercase tracking-wide font-bold" style={{ color: '#9CA3AF' }}>{L('Tổng thanh toán', 'Total to pay')}</div>
              <div className="text-xl font-extrabold tabular-nums" style={{ color: NAVY }}>{fmt(total)}</div>
            </div>
            <button onClick={() => confirmSale('cash')} disabled={submitting}
              className="w-full flex items-center justify-center gap-2 text-sm font-extrabold rounded-xl py-3 disabled:opacity-60"
              style={{ backgroundColor: '#1A4731', color: '#FFFAEE' }}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={16} />}
              {L('Tiền mặt', 'Cash')}
            </button>
            <button onClick={() => setPaymentStep('transferQr')} disabled={submitting}
              className="w-full flex items-center justify-center gap-2 text-sm font-extrabold rounded-xl py-3"
              style={{ backgroundColor: GOLD_PALE, color: '#8A6D14', border: `1px solid ${GOLD}` }}>
              <QrCode size={16} />
              {L('Chuyển khoản', 'Bank transfer')}
            </button>
            <button onClick={() => setPaymentStep('idle')} className="w-full text-center text-xs font-semibold py-1.5" style={{ color: '#9CA3AF' }}>
              {L('Huỷ', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Full-screen QR (Axel, 2026-09-14): "pour que le client scan le QR faut que la photo se
          mette en pleine ecran" — the small in-sheet thumbnail was too small to scan comfortably;
          this now takes over the whole screen so the QR itself can be shown as large as possible
          when the phone is turned toward the customer. */}
      {paymentStep === 'transferQr' && (
        <div className="fixed inset-0 z-20 flex flex-col" style={{ backgroundColor: '#fff' }}>
          <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <button onClick={() => setPaymentStep('choosing')} className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: '#9CA3AF' }}>
              <ArrowLeft size={12} /> {L('Quay lại', 'Back')}
            </button>
            <div className="text-right">
              <div className="text-[9.5px] uppercase tracking-wide font-bold" style={{ color: '#9CA3AF' }}>{L('Chuyển khoản', 'Bank transfer')}</div>
              <div className="text-sm font-extrabold tabular-nums" style={{ color: NAVY }}>{fmt(total)}</div>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center p-4 min-h-0">
            {qrCodeUrl ? (
              <img src={qrCodeUrl} alt={L('QR chuyển khoản', 'Bank transfer QR')} className="max-w-full max-h-full rounded-xl object-contain" style={{ border: `1px solid ${BORDER}` }} />
            ) : (
              <div className="text-xs text-center rounded-lg px-3 py-4" style={{ backgroundColor: GOLD_PALE, color: '#8A6D14' }}>
                {L('Chưa có QR cho event này — nhờ admin tải lên ở trang quản lý Event.', 'No QR for this event yet — ask an admin to upload one on the Event shops page.')}
              </div>
            )}
          </div>
          <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: `1px solid ${BORDER}` }}>
            <button onClick={() => confirmSale('transfer')} disabled={submitting}
              className="w-full flex items-center justify-center gap-2 text-sm font-extrabold rounded-xl py-3 disabled:opacity-60"
              style={{ backgroundColor: '#1A4731', color: '#FFFAEE' }}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {L('Đã chuyển khoản — Xác nhận', 'Transfer received — Confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
