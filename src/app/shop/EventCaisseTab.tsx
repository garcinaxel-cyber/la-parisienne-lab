'use client';
import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, CheckCircle2, Loader2, Banknote, QrCode, ArrowLeft, Gift, Search, Cake, ShoppingBag, TrendingUp } from 'lucide-react';
import { getEventCaisseCatalogAction, recordEventSaleAction, type EventCaisseProduct, type ShopStaffName } from './actions';
import { NamePicker, NAVY, GOLD, GOLD_PALE, INK, BORDER, GREEN, RED, NAME_STORAGE_KEY, LOSS_NAME_STORAGE_KEY, STOCK_NAME_STORAGE_KEY } from './ShopView';
import EventSalesView from './EventSalesView';
import { useShopL } from './shop-lang';
import { thumb } from '@/lib/img-thumb';

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

// Seller (Axel, 2026-10-07): the till never asks for a name at a sale — "j'ai peur que ça leur
// prenne du temps à chaque vendeur à chaque vente". It reuses the name this phone already
// remembers from the other event screens (deliveries, losses, stock count) and shows it in one
// small row; whoever takes over the phone changes it there, once. Its own key so that switching
// seller at the till does not rename the person who confirms deliveries.
const SALE_NAME_STORAGE_KEY = 'lab_shop_sale_name';

// Fixed promos (Axel, 2026-10-08, Aeon Hải Phòng event): "MCR mua 5 tặng 1, Bánh Tira mini + bánh
// vuông mua 2 tặng 1 (Chopiraps, Oreolé, Delight)", then "Hạt điều cũng để mua 2 tặng 1" and "Bonbon
// meringue cũng mua 2 tặng 1". Each group
// is counted across all its products (flavours mix): every buy+1 units, one is free. The free units
// go to the cheapest products of the group first. A line put on discount leaves its group.
type PromoGroup = { id: string; buy: number; vi: string; en: string; shortVi: string; shortEn: string; match: (p: EventCaisseProduct) => boolean };
const PROMO_GROUPS: PromoGroup[] = [
  { id: 'macaron', buy: 5, shortVi: 'macaron', shortEn: 'macaron', vi: 'Macaron mua 5 tặng 1', en: 'Macarons: buy 5, get 1 free',
    match: p => p.category === 'Macaron' || /^BMCR/i.test(p.sku) },
  { id: 'tira-carre', buy: 2, shortVi: 'tiramisu mini / bánh vuông', shortEn: 'mini tiramisu / square cake', vi: 'Tiramisu mini + bánh vuông (Chopiraps, Oreolé, Chopiraps / Oreolé mini, Matcha Delight) mua 2 tặng 1', en: 'Mini tiramisu + square cakes (Chopiraps, Oreolé, mini Chopiraps / Oreolé, Matcha Delight): buy 2, get 1 free',
    // Axel, 2026-10-08: the mini Oreolé (WMOROLMN, 130 g) and mini Chopiraps (WMCPRMN, 104 g) are in this promo too.
    match: p => /tiramisu mini/i.test(p.name) || /(oreol[eé]|chopiraps) mini/i.test(p.name) || ['BCPRT', 'BOROL', 'BMCDL', 'WMOROLMN', 'WMCPRMN'].includes(p.sku) },
  { id: 'cashew', buy: 2, shortVi: 'hạt điều', shortEn: 'cashews', vi: 'Hạt điều mua 2 tặng 1', en: 'Cashews: buy 2, get 1 free',
    match: p => /^hạt điều/i.test(p.name.trim()) },
  { id: 'meringue', buy: 2, shortVi: 'bonbon meringue', shortEn: 'meringue', vi: 'Bonbon meringue mua 2 tặng 1', en: 'Meringue bonbons: buy 2, get 1 free',
    match: p => /^bonbon meringue/i.test(p.name.trim()) },
  // Axel, 2026-10-08: "cho chạy mua 2 tặng 1 bánh lưỡi mèo luôn nhé" — all flavours mixed, like the cashews.
  { id: 'langue-de-chat', buy: 2, shortVi: 'bánh lưỡi mèo', shortEn: 'langue de chat', vi: 'Bánh quy lưỡi mèo mua 2 tặng 1', en: 'Langue de chat biscuits: buy 2, get 1 free',
    match: p => /lưỡi mèo/i.test(p.name) || /^BQLM/i.test(p.sku) },
];
const DEFAULT_DISCOUNT = 10;

export default function EventCaisseTab({ staffNames = null, onManageStaff }: { staffNames?: ShopStaffName[] | null; onManageStaff?: () => void }) {
  const L = useShopL();
  // "Bán hàng" = the till itself; "Doanh thu" = what was sold (per day, cash / transfer, every
  // transaction) — a screen of its own instead of a list under some forty products.
  const [view, setView] = useState<'sell' | 'sales'>('sell');
  const [seller, setSeller] = useState('');
  useEffect(() => {
    try {
      setSeller(localStorage.getItem(SALE_NAME_STORAGE_KEY) ?? localStorage.getItem(NAME_STORAGE_KEY)
        ?? localStorage.getItem(LOSS_NAME_STORAGE_KEY) ?? localStorage.getItem(STOCK_NAME_STORAGE_KEY) ?? '');
    } catch {}
  }, []);
  function changeSeller(v: string) {
    setSeller(v);
    try { localStorage.setItem(SALE_NAME_STORAGE_KEY, v); } catch {}
  }
  const [products, setProducts] = useState<EventCaisseProduct[] | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [freeCart, setFreeCart] = useState<Record<string, number>>({});
  // sku -> % off its paid units (Axel, 2026-10-08: "en %, pré-rempli 10 %", per product). Absent = no discount.
  const [discount, setDiscount] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Axel, 2026-09-14: "un filtre par nom et aussi par categorie" — name search + category pills
  // over the product grid; category comes from the fiche (see getEventCaisseCatalogAction).
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // 'idle' = cart view; 'choosing' = pick cash/transfer; 'transferQr' = showing the QR to confirm.
  const [paymentStep, setPaymentStep] = useState<'idle' | 'choosing' | 'transferQr'>('idle');

  async function load() {
    const p = await getEventCaisseCatalogAction();
    setProducts(p.products ?? []);
    setQrCodeUrl(p.qrCodeUrl ?? null);
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

  const groupOf = useMemo(() => {
    const m = new Map<string, PromoGroup>();
    for (const p of products ?? []) { const g = PROMO_GROUPS.find(x => x.match(p)); if (g) m.set(p.sku, g); }
    return m;
  }, [products]);
  // Free units per sku: the fixed promo of its group, else what staff marked by hand. A discounted
  // line has none. Plus, per group, whether the customer is one unit away from another free one.
  const { freeBySku, promoHints } = useMemo(() => {
    const freeBySku: Record<string, number> = {};
    const promoHints: PromoGroup[] = [];
    for (const g of PROMO_GROUPS) {
      const lines = (products ?? []).filter(p => groupOf.get(p.sku) === g && (cart[p.sku] ?? 0) > 0 && discount[p.sku] == null)
        .sort((a, b) => a.unitPrice - b.unitPrice);
      const units = lines.reduce((s, p) => s + (cart[p.sku] ?? 0), 0);
      let left = Math.floor(units / (g.buy + 1));
      for (const p of lines) { const f = Math.min(left, cart[p.sku] ?? 0); if (f > 0) freeBySku[p.sku] = f; left -= f; }
      if (units > 0 && units % (g.buy + 1) === g.buy) promoHints.push(g);
    }
    for (const [sku, qty] of Object.entries(cart)) {
      if (groupOf.has(sku) || discount[sku] != null) continue;
      const f = Math.min(freeCart[sku] ?? 0, qty);
      if (f > 0) freeBySku[sku] = f;
    }
    return { freeBySku, promoHints };
  }, [products, cart, freeCart, discount, groupOf]);
  const paidUnit = (sku: string) => {
    const price = products?.find(x => x.sku === sku)?.unitPrice ?? 0;
    return Math.round(price * (100 - (discount[sku] ?? 0)) / 100);
  };
  const total = Object.entries(cart).reduce((sum, [sku, qty]) => sum + Math.max(0, qty - (freeBySku[sku] ?? 0)) * paidUnit(sku), 0);
  const discountSaved = Object.entries(cart).reduce((sum, [sku, qty]) => {
    const price = products?.find(x => x.sku === sku)?.unitPrice ?? 0;
    return sum + (discount[sku] != null ? Math.max(0, qty - (freeBySku[sku] ?? 0)) * (price - paidUnit(sku)) : 0);
  }, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const freeCount = Object.values(freeBySku).reduce((a, b) => a + b, 0);
  function setLineDiscount(sku: string, pct: number | null) {
    setDiscount(d => {
      const n = { ...d };
      if (pct == null) delete n[sku]; else n[sku] = Math.max(1, Math.min(100, Math.round(pct)));
      return n;
    });
  }

  async function confirmSale(paymentMethod: 'cash' | 'transfer') {
    setSubmitting(true);
    setMsg(null);
    const items = Object.entries(cart).filter(([, qty]) => qty > 0)
      .map(([sku, qty]) => ({ sku, qty, freeQty: freeBySku[sku] ?? 0, discountPct: discount[sku] ?? 0 }));
    const res = await recordEventSaleAction(items, paymentMethod, seller.trim() || undefined);
    setSubmitting(false);
    setPaymentStep('idle');
    if (res.error) { setMsg(res.error); return; }
    setCart({}); setFreeCart({}); setDiscount({});
    setMsg(L('✓ Đã ghi nhận bán hàng (không ảnh hưởng Odoo)', '✓ Sale recorded (no impact on Odoo)'));
    load();
  }

  const viewSwitch = (
    <div className="grid grid-cols-2 gap-1 bg-white rounded-xl p-1" style={{ border: `1px solid ${BORDER}` }}>
      {([['sell', L('Bán hàng', 'Sell'), ShoppingBag], ['sales', L('Doanh thu', 'Sales'), TrendingUp]] as const).map(([k, label, Icon]) => (
        <button key={k} onClick={() => setView(k)} className="inline-flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13.5px] font-extrabold"
          style={{ backgroundColor: view === k ? NAVY : 'transparent', color: view === k ? '#fff' : '#6B7280' }}>
          <Icon size={15} /> {label}
        </button>
      ))}
    </div>
  );

  if (view === 'sales') return <div className="space-y-3 pb-6">{viewSwitch}<EventSalesView /></div>;

  if (!products) return <div className="space-y-3">{viewSwitch}<div className="text-center py-10 text-sm" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div></div>;

  return (
    <div className="space-y-3 pb-20">
      {viewSwitch}
      <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2" style={{ border: `1px solid ${BORDER}` }}>
        <span className="text-xs font-semibold shrink-0" style={{ color: '#6B7280' }}>{L('Người bán', 'Seller')}</span>
        <NamePicker value={seller} onChange={changeSeller} names={staffNames} onManage={onManageStaff ?? (() => {})} />
      </div>
      <div className="rounded-xl px-3.5 py-2.5 text-xs font-semibold" style={{ backgroundColor: GOLD_PALE, border: `1px solid ${GOLD}`, color: '#8A6D14' }}>
        {L('📦 Sản phẩm lấy từ các đơn hàng (REP) của event, kể cả khi chưa xác nhận nhận hàng. Vẫn bán được khi số tồn về 0 hoặc âm.', '📦 Products come from the event\'s orders (REP), even before they are confirmed as received. Selling stays possible at zero or below.')}
      </div>

      {PROMO_GROUPS.some(g => products.some(p => groupOf.get(p.sku) === g)) && (
        <div className="rounded-xl px-3.5 py-2.5 text-xs font-semibold space-y-0.5" style={{ backgroundColor: '#FEF3C7', border: '1px solid #E5C77A', color: '#92600A' }}>
          {PROMO_GROUPS.filter(g => products.some(p => groupOf.get(p.sku) === g)).map(g => (
            <div key={g.id} className="flex items-start gap-1.5"><Gift size={12} className="mt-0.5 flex-shrink-0" /> <span>{L(g.vi, g.en)}</span></div>
          ))}
          <div className="font-normal" style={{ color: '#A16207' }}>{L('Tự động tính trong giỏ, trộn được các vị.', 'Worked out automatically in the cart, flavours can be mixed.')}</div>
        </div>
      )}

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
            const group = groupOf.get(p.sku);
            const disc = discount[p.sku];
            const free = freeBySku[p.sku] ?? 0;
            const remaining = p.available - qty;
            return (
              <div key={p.sku} className="bg-white rounded-2xl p-3" style={{ border: `1px solid ${BORDER}` }}>
                <div className="w-full aspect-square rounded-xl mb-2 flex items-center justify-center overflow-hidden" style={{ backgroundColor: GOLD_PALE }}>
                  {p.imageUrl ? (
                    // Through the image optimizer like every other product photo in the app: several
                    // of these are ~1.8 MB PNGs in storage, and the till shows the whole range at once.
                    <img src={thumb(p.imageUrl, 400)} alt={p.name} loading="lazy" className="w-full h-full object-cover" />
                  ) : (
                    <Cake size={26} style={{ color: GOLD }} />
                  )}
                </div>
                <div className="text-[13px] font-bold leading-tight" style={{ color: INK }}>{p.name}</div>
                <div className="text-[10.5px] mt-0.5" style={{ color: remaining <= 0 ? RED : '#9CA3AF' }}>{L('Còn', 'Left')} <b>{remaining}</b></div>
                <div className="text-xs font-extrabold mt-1" style={{ color: '#8A6D14' }}>
                  {disc != null ? <><span className="line-through font-semibold" style={{ color: '#9CA3AF' }}>{fmt(p.unitPrice)}</span> {fmt(paidUnit(p.sku))}</> : fmt(p.unitPrice)}
                </div>
                {group && (
                  <div className="inline-flex items-center gap-1 text-[10px] font-bold mt-1 rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                    <Gift size={10} /> {L(`Mua ${group.buy} tặng 1`, `Buy ${group.buy} get 1`)}
                  </div>
                )}
                <div className="flex items-center justify-between mt-2 rounded-lg px-1.5 py-1" style={{ backgroundColor: GOLD_PALE }}>
                  <button onClick={() => changeQty(p.sku, -1)} className="w-10 h-10 rounded-lg text-white font-bold flex items-center justify-center" style={{ backgroundColor: NAVY }} aria-label={L('Bớt 1', 'Remove one')}>
                    <Minus size={16} />
                  </button>
                  <span className="text-base font-extrabold tabular-nums">{qty}</span>
                  <button onClick={() => changeQty(p.sku, 1)} className="w-10 h-10 rounded-lg text-white font-bold flex items-center justify-center" style={{ backgroundColor: NAVY }} aria-label={L('Thêm 1', 'Add one')}>
                    <Plus size={16} />
                  </button>
                </div>
                {/* Promo (Axel, 2026-09-14): "buy X get 1 free" decided by staff at the till, no
                    rule config — this just marks how many of the units above are free. Products of a
                    fixed promo group (PROMO_GROUPS) get theirs worked out instead, read-only. */}
                {qty > 0 && disc == null && group && (
                  <div className="flex items-center justify-between gap-1 mt-1.5 rounded-lg px-1.5 py-1.5" style={{ backgroundColor: free > 0 ? '#FEF3C7' : 'transparent' }}>
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold" style={{ color: free > 0 ? '#92600A' : '#9CA3AF' }}>
                      <Gift size={11} /> {L('Tặng tự động', 'Free (auto)')}
                    </span>
                    <span className="text-xs font-extrabold tabular-nums" style={{ color: free > 0 ? '#92600A' : '#9CA3AF' }}>{free}</span>
                  </div>
                )}
                {qty > 0 && disc == null && !group && (
                  <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-1 mt-1.5 rounded-lg px-1.5 py-1" style={{ backgroundColor: free > 0 ? '#FEF3C7' : 'transparent' }}>
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold whitespace-nowrap" style={{ color: free > 0 ? '#92600A' : '#9CA3AF' }}>
                      <Gift size={11} /> {L('Miễn phí', 'Free')}
                    </span>
                    <div className="flex items-center gap-1.5 ml-auto">
                      <button onClick={() => changeFree(p.sku, -1)} disabled={free <= 0} className="w-8 h-8 rounded-md flex items-center justify-center disabled:opacity-30" style={{ backgroundColor: '#fff', border: '1px solid #E5C77A' }} aria-label={L('Bớt 1 miễn phí', 'One less free')}>
                        <Minus size={13} />
                      </button>
                      <span className="text-xs font-extrabold tabular-nums" style={{ minWidth: 12, textAlign: 'center' }}>{free}</span>
                      <button onClick={() => changeFree(p.sku, 1)} disabled={free >= qty} className="w-8 h-8 rounded-md flex items-center justify-center disabled:opacity-30" style={{ backgroundColor: '#fff', border: '1px solid #E5C77A' }} aria-label={L('Thêm 1 miễn phí', 'One more free')}>
                        <Plus size={13} />
                      </button>
                    </div>
                  </div>
                )}
                {/* Discount (Axel, 2026-10-08): per product, in %, pre-filled at 10 % — the other
                    promo choice for a line, so a discounted line has no free unit. */}
                {qty > 0 && (disc == null ? (
                  <button onClick={() => setLineDiscount(p.sku, DEFAULT_DISCOUNT)}
                    className="w-full mt-1.5 rounded-lg py-1.5 text-[11px] font-bold" style={{ border: '1px dashed #E5C77A', color: '#8A6D14' }}>
                    {L('Giảm giá %', 'Discount %')}
                  </button>
                ) : (
                  <div className="mt-1.5 rounded-lg px-1.5 py-1" style={{ backgroundColor: '#EAF6EC' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10.5px] font-bold" style={{ color: GREEN }}>{L('Giảm giá', 'Discount')}</span>
                      <button onClick={() => setLineDiscount(p.sku, null)} className="text-[10.5px] font-bold px-1 py-0.5" style={{ color: '#9CA3AF' }}>{L('Bỏ', 'Remove')}</button>
                    </div>
                    <div className="flex items-center justify-center gap-1 mt-0.5">
                      <button onClick={() => setLineDiscount(p.sku, disc - 5)} disabled={disc <= 5} className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30" style={{ backgroundColor: '#fff', border: '1px solid #B7DFC0' }} aria-label={L('Giảm bớt 5%', '5% less')}>
                        <Minus size={12} />
                      </button>
                      <input inputMode="numeric" value={disc} onChange={e => { const v = parseInt(e.target.value.replace(/\D/g, ''), 10); if (!isNaN(v)) setLineDiscount(p.sku, v); }}
                        className="w-9 h-7 rounded-md text-center text-xs font-extrabold tabular-nums" style={{ border: '1px solid #B7DFC0', outline: 'none' }} aria-label="%" />
                      <span className="text-[11px] font-bold" style={{ color: GREEN }}>%</span>
                      <button onClick={() => setLineDiscount(p.sku, disc + 5)} disabled={disc >= 100} className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-30" style={{ backgroundColor: '#fff', border: '1px solid #B7DFC0' }} aria-label={L('Giảm thêm 5%', '5% more')}>
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                ))}
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

      {cartCount > 0 && paymentStep === 'idle' && (
        <div className="fixed left-0 right-0 bottom-0 !mt-0 px-4 pt-3 flex items-center justify-between gap-3" style={{ backgroundColor: '#1A4731', paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="max-w-xl mx-auto w-full flex items-center justify-between gap-3">
            <div>
              <div className="text-[9.5px] uppercase tracking-wide font-bold" style={{ color: '#F0D98A' }}>
                {L('Tổng đơn', 'Sale total')}{freeCount > 0 ? ` · ${freeCount} ${L('miễn phí', 'free')}` : ''}{discountSaved > 0 ? ` · ${L('giảm', 'off')} ${fmt(discountSaved)}` : ''}
              </div>
              {promoHints.length > 0 && (
                <div className="text-[10.5px] font-bold" style={{ color: '#F0D98A' }}>
                  🎁 {L('Được tặng thêm 1', '1 more free')}: {promoHints.map(g => L(g.shortVi, g.shortEn)).join(', ')}
                </div>
              )}
              <div className="text-base font-extrabold tabular-nums" style={{ color: '#FFFAEE' }}>{fmt(total)}</div>
            </div>
            <button onClick={() => setPaymentStep('choosing')}
              className="inline-flex items-center gap-1.5 text-sm font-extrabold rounded-xl px-4 py-2.5 whitespace-nowrap flex-shrink-0"
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
        <div className="fixed inset-0 !mt-0 z-10 flex flex-col justify-end" style={{ backgroundColor: 'rgba(26,71,49,0.55)' }} onClick={() => setPaymentStep('idle')}>
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
        <div className="fixed inset-0 !mt-0 z-20 flex flex-col" style={{ backgroundColor: '#fff' }}>
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
