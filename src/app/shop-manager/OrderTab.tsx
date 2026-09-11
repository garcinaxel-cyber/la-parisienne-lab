'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Plus, Minus, Trash2, Send, Loader2, ChevronRight, CheckCircle2, Truck } from 'lucide-react';
import { useI18n, type Lang } from '@/lib/i18n';
import {
  NamePicker,
} from '@/app/shop/ShopView';
import {
  getManagerOrderContextAction, getManagerOrderCategoriesAction, getManagerOrderDraftAction,
  saveManagerOrderDraftAction, discardManagerOrderDraftAction, searchManagerOrderProductsAction,
  getShopCurrentStockLevelsAction, submitManagerOrderAction, getShopStaffNamesAction,
  type ShopManagerOrderDraft, type ShopManagerCatalogProduct, type ShopStockLevel, type ShopStaffName,
} from '@/app/shop/actions';
import { thumb } from '@/lib/img-thumb';
import { NAVY, GOLD, CREAM, INK, INK_LIGHT, BORDER, GREEN, AMBER, RED } from './ShopManagerView';

// Dedicated manager Order screen (Axel, 2026-09-10 follow-up) — replaces jumping into the full
// staff ShopView (7 tabs, staff-grey header) for this entry point: this is a genuine 3rd tab of
// the manager cockpit (client-state, no navigation), styled navy/gold to match Today/Team, and
// built from Axel's own mockup — draft banner collapsed by default, product search, live
// inventory with the last count's date+time up top, a sticky item-count/confirm bar. It calls
// the EXACT SAME server actions ShopView's order tab already uses (no new backend, no new
// routes — Axel: "optimise ... pour que l usage supabase/vercel soit reduit"), just a different
// shell around them. "Store interface" (the other quick action) is untouched — it still opens
// the real ShopView via /shop-manager/store, unrelated to this rebuild.
//
// One gap vs the mockup: the mockup's sticky bar shows a money total ("485,000 đ") and its
// inventory rows show a 3rd "Low" state — neither exists in the underlying data yet
// (ShopManagerCatalogProduct/ShopStockLevel carry no price and no low-stock threshold), so this
// shows item count only and a plain in/out-of-stock pill rather than inventing numbers.

const L = {
  vi: {
    addProducts: 'Thêm sản phẩm', searchPh: 'Tìm sản phẩm hoặc packaging…',
    liveInventory: 'Tồn kho gần nhất', lastCount: 'Kiểm gần nhất',
    all: 'Tất cả', inStock: 'Còn hàng', outOfStock: 'Hết hàng', filterPh: 'Lọc theo tên…',
    noInvToday: 'Chưa có dữ liệu kiểm kho hôm nay', loading: 'Đang tải…',
    startedByStaff: 'Nhân viên đã bắt đầu', reviewConfirm: 'Xem lại & xác nhận',
    emptyCart: 'Giỏ hàng trống — tìm và thêm sản phẩm ở trên',
    yourName: 'Tên của bạn', delivery: 'Giao hàng', saveDraft: 'Lưu nháp', discardDraft: 'Xoá nháp',
    confirmOrder: 'Xác nhận đơn hàng', pinLabel: 'Mã PIN quản lý', pinPh: 'Mã PIN',
    cancel: 'Huỷ', confirm: 'Xác nhận', pinNote: 'Đơn hàng này sẽ được tạo và xác nhận ngay trên Odoo — không thể huỷ trong app.',
    successTitle: 'Đã xác nhận đơn hàng', successRef: 'Mã đơn Odoo', newOrder: 'Đặt đơn khác',
    lateWarning: '⚠️ Đã quá 14h00 — đặt cho ngày mai lúc này KHÔNG ĐÚNG QUY TRÌNH. Đơn vẫn được gửi nếu quản lý xác nhận, nhưng vui lòng tránh đặt sau 14h00 vào các lần sau.',
    normalNoteTomorrow: 'Đặt cho ngày mai: ai cũng thêm được sản phẩm, quản lý xác nhận bằng mã PIN trước 14h00.',
    normalNoteLater: 'Đặt cho ngày này: ai cũng thêm được sản phẩm, quản lý xác nhận bằng mã PIN khi sẵn sàng.',
  },
  en: {
    addProducts: 'Add products', searchPh: 'Search a product or SKU…',
    liveInventory: 'Live inventory', lastCount: 'Last count',
    all: 'All', inStock: 'In stock', outOfStock: 'Out of stock', filterPh: 'Filter by name…',
    noInvToday: 'No stock count data yet today', loading: 'Loading…',
    startedByStaff: 'Started by staff', reviewConfirm: 'Review & confirm',
    emptyCart: 'Cart is empty — search and add products above',
    yourName: 'Your name', delivery: 'Delivery', saveDraft: 'Save draft', discardDraft: 'Discard draft',
    confirmOrder: 'Confirm order', pinLabel: 'Manager PIN', pinPh: 'PIN',
    cancel: 'Cancel', confirm: 'Confirm', pinNote: 'This order is created and confirmed immediately in Odoo — it cannot be cancelled in the app.',
    successTitle: 'Order confirmed', successRef: 'Odoo order ref', newOrder: 'Place another order',
    lateWarning: '⚠️ Past 14:00 — ordering for tomorrow now is AGAINST PROCESS. It still goes through if a manager confirms, but please avoid ordering after 14:00 next time.',
    normalNoteTomorrow: 'Ordering for tomorrow: anyone can add products, a manager confirms with their PIN before 14:00.',
    normalNoteLater: 'Ordering for this date: anyone can add products, a manager confirms with their PIN whenever ready.',
  },
} as const;
type LKey = keyof typeof L.vi;
function useL() {
  const { lang, setLang } = useI18n();
  const d = (lang === 'en' ? L.en : L.vi) as Record<LKey, string>;
  return { tr: (k: LKey) => d[k], lang, setLang };
}

function fmtDate(d: string, lang: Lang) {
  const [y, m, day] = d.split('-');
  return lang === 'en' ? `${m}/${day}` : `${day}/${m}`;
}
function fmtRelative(iso: string, lang: Lang): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return lang === 'en' ? 'just now' : 'vừa xong';
  if (mins < 60) return lang === 'en' ? `${mins} min ago` : `${mins} phút trước`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return lang === 'en' ? `${hours}h ago` : `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  return lang === 'en' ? `${days}d ago` : `${days} ngày trước`;
}
function fmtLastCount(iso: string, lang: Lang): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  return `${date} ${time}`;
}
function fmtItems(n: number, lang: Lang) {
  return lang === 'en' ? `${n} item${n !== 1 ? 's' : ''}` : `${n} sản phẩm`;
}

type CartLine = { sku: string; name: string; qty: number; note: string; imageUrl: string | null };

export default function OrderTab({ activeShop, managerName }: { activeShop: string; managerName: string }) {
  const { tr, lang } = useL();

  const [createdByName, setCreatedByName] = useState(managerName);
  const [deliveryDate, setDeliveryDate] = useState<string | null>(null);
  const [deliveryTime, setDeliveryTime] = useState('09:00');
  const [minDate, setMinDate] = useState<string | null>(null);
  const [tomorrowOpen, setTomorrowOpen] = useState(true);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ShopManagerCatalogProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [draftLoaded, setDraftLoaded] = useState<ShopManagerOrderDraft | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [confirmPin, setConfirmPin] = useState('');
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderRef: string; deliveryDate: string; deliveryTime?: string; managerName?: string } | null>(null);
  const [invLevels, setInvLevels] = useState<ShopStockLevel[] | null>(null);
  const [invAsOf, setInvAsOf] = useState<string | null>(null);
  const [invFilter, setInvFilter] = useState<'all' | 'in' | 'out'>('all');
  const [invQuery, setInvQuery] = useState('');
  const [staffNames, setStaffNames] = useState<ShopStaffName[] | null>(null);
  const cartDirtyRef = useRef(false);

  // Order context (min/default delivery date) + categories + live inventory + staff roster —
  // all loaded once per shop, same posture as ShopView's own order tab.
  useEffect(() => {
    (async () => {
      const [ctx, cats, inv, staff] = await Promise.all([
        getManagerOrderContextAction(),
        getManagerOrderCategoriesAction(activeShop),
        getShopCurrentStockLevelsAction(activeShop),
        getShopStaffNamesAction(activeShop),
      ]);
      setMinDate(ctx.minDate ?? null);
      setTomorrowOpen(ctx.tomorrowOrderingOpen ?? true);
      setDeliveryDate(ctx.defaultDate ?? ctx.minDate ?? null);
      setCategories(cats.categories ?? []);
      setInvLevels(inv.levels ?? []);
      setInvAsOf(inv.asOf ?? null);
      setStaffNames(staff.names ?? []);
    })();
  }, [activeShop]);

  const loadDraft = useCallback(async (date: string) => {
    const res = await getManagerOrderDraftAction(date, activeShop);
    if (res.error) return;
    const draft = res.draft ?? null;
    setDraftLoaded(draft);
    if (draft) {
      setCart(draft.lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note ?? '', imageUrl: null })));
      if (draft.deliveryTime) setDeliveryTime(draft.deliveryTime);
      if (draft.createdByName) setCreatedByName(draft.createdByName);
      setCartExpanded(false);
    } else {
      setCart([]);
    }
    cartDirtyRef.current = false;
  }, [activeShop]);

  useEffect(() => { if (deliveryDate) loadDraft(deliveryDate); }, [deliveryDate, loadDraft]);

  // Same quiet 15s poll as ShopView — picks up a staff member's draft edits without ever
  // clobbering local in-progress work (dirty flag) or interrupting a PIN confirm in flight.
  useEffect(() => {
    if (!deliveryDate) return;
    const id = setInterval(() => {
      if (!cartDirtyRef.current && !pendingConfirm) loadDraft(deliveryDate);
    }, 15000);
    return () => clearInterval(id);
  }, [deliveryDate, pendingConfirm, loadDraft]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2 && !categoryFilter) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await searchManagerOrderProductsAction(q, activeShop, categoryFilter ?? undefined);
      setSearching(false);
      setSearchResults(res.products ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [searchQuery, categoryFilter, activeShop]);

  function setQtyForProduct(p: ShopManagerCatalogProduct, qty: number) {
    const clamped = Math.max(0, Math.floor(qty) || 0);
    cartDirtyRef.current = true;
    setCartExpanded(true);
    setCart(prev => {
      const exists = prev.some(l => l.sku === p.sku);
      if (!exists) return clamped > 0 ? [...prev, { sku: p.sku, name: p.name, qty: clamped, note: '', imageUrl: p.imageUrl }] : prev;
      return prev.map(l => l.sku === p.sku ? { ...l, qty: clamped } : l);
    });
  }
  function updateQty(sku: string, qty: number) {
    cartDirtyRef.current = true;
    setCart(prev => prev.map(l => l.sku === sku ? { ...l, qty: Math.max(0, Math.floor(qty) || 0) } : l));
  }
  function updateNote(sku: string, note: string) {
    cartDirtyRef.current = true;
    setCart(prev => prev.map(l => l.sku === sku ? { ...l, note } : l));
  }
  function removeItem(sku: string) {
    cartDirtyRef.current = true;
    setCart(prev => prev.filter(l => l.sku !== sku));
  }

  async function saveDraft(): Promise<boolean> {
    const name = createdByName.trim();
    if (!name || !deliveryDate || !cart.some(l => l.qty > 0)) return false;
    setDraftSaving(true);
    const res = await saveManagerOrderDraftAction({
      shopName: activeShop, createdByName: name, deliveryDate, deliveryTime,
      lines: cart.filter(l => l.qty > 0).map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note.trim() || undefined })),
    });
    setDraftSaving(false);
    if (res.error) { setMsg(res.error); return false; }
    setDraftLoaded(res.draft ?? null);
    cartDirtyRef.current = false;
    return true;
  }

  async function discardDraft() {
    if (!deliveryDate) return;
    await discardManagerOrderDraftAction(deliveryDate, activeShop);
    setDraftLoaded(null);
    setCart([]);
    setMsg(null);
    cartDirtyRef.current = false;
  }

  async function openConfirm() {
    setMsg(null);
    await saveDraft();
    setConfirmPin('');
    setConfirmMsg(null);
    setPendingConfirm(true);
  }

  async function confirmOrder() {
    if (!confirmPin.trim()) { setConfirmMsg(tr('pinLabel')); return; }
    setSubmitting(true);
    setConfirmMsg(null);
    const res = await submitManagerOrderAction({
      pin: confirmPin.trim(), shopName: activeShop, deliveryDate: deliveryDate ?? '', deliveryTime,
      lines: cart.filter(l => l.qty > 0).map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note.trim() || undefined })),
    });
    setSubmitting(false);
    if (res.error || !res.orderRef || !res.deliveryDate) { setConfirmMsg(res.error ?? 'Error'); return; }
    setPendingConfirm(false);
    setConfirmPin('');
    setResult({ orderRef: res.orderRef, deliveryDate: res.deliveryDate, deliveryTime: res.deliveryTime, managerName: res.managerName });
    setCart([]);
    setDraftLoaded(null);
    cartDirtyRef.current = false;
  }

  const itemCount = cart.filter(l => l.qty > 0).length;

  if (result) {
    return (
      <div className="bg-white rounded-2xl p-6 space-y-3 text-center" style={{ border: `1px solid ${BORDER}` }}>
        <CheckCircle2 size={32} className="mx-auto" style={{ color: GREEN }} />
        <div className="text-sm font-bold" style={{ color: INK }}>{tr('successTitle')}</div>
        <div className="text-xs" style={{ color: INK_LIGHT }}>
          {fmtDate(result.deliveryDate, lang)}{result.deliveryTime ? ` · ${result.deliveryTime}` : ''}{result.managerName ? ` · ${result.managerName}` : ''}
        </div>
        <div className="rounded-xl px-4 py-3" style={{ backgroundColor: CREAM }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('successRef')}</div>
          <div className="text-lg font-bold" style={{ color: INK }}>{result.orderRef}</div>
        </div>
        <button onClick={() => setResult(null)} className="w-full text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: NAVY }}>
          {tr('newOrder')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-16">
      {/* Name + delivery date/time — needed before anything can be submitted, kept compact and
          out of the way (matches the mockup's collapsed initial view) since it's pre-filled with
          sensible defaults (this manager's own name, next open delivery date). */}
      <div className="bg-white rounded-2xl p-3.5 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold shrink-0" style={{ color: INK_LIGHT }}>{tr('yourName')}</span>
          <NamePicker value={createdByName} onChange={setCreatedByName} names={staffNames} onManage={() => {}} />
        </div>
        <div className="flex items-center gap-2">
          <Truck size={14} className="shrink-0" style={{ color: INK_LIGHT }} />
          <span className="text-xs font-semibold shrink-0" style={{ color: INK_LIGHT }}>{tr('delivery')}:</span>
          <input type="date" value={deliveryDate ?? ''} min={minDate ?? undefined} onChange={e => setDeliveryDate(e.target.value)}
            className="flex-1 min-w-0 rounded-lg px-2 py-1 text-sm font-bold" style={{ border: `1px solid ${BORDER}` }} />
          <input type="time" value={deliveryTime} onChange={e => setDeliveryTime(e.target.value)}
            className="w-[88px] shrink-0 rounded-lg px-2 py-1 text-sm font-bold" style={{ border: `1px solid ${BORDER}` }} />
        </div>
        {deliveryDate && minDate && deliveryDate === minDate && !tomorrowOpen ? (
          <div className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold" style={{ backgroundColor: '#FDECEC', color: RED, border: `1px solid #F5B5AD` }}>
            {tr('lateWarning')}
          </div>
        ) : (
          <div className="text-[10.5px]" style={{ color: INK_LIGHT }}>
            {deliveryDate && minDate && deliveryDate === minDate ? tr('normalNoteTomorrow') : tr('normalNoteLater')}
          </div>
        )}
      </div>

      {/* Draft banner — collapsed by default when there's already something in the cart (a
          staff member's prefill, or a draft from earlier), expands into the full editable cart
          on tap so the initial screen stays focused on search + inventory. */}
      {cart.length > 0 && !cartExpanded && (
        <div className="rounded-2xl p-3.5 bg-white" style={{ borderLeft: `4px solid ${AMBER}`, border: `1px solid ${BORDER}`, borderLeftWidth: 4 }}>
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: AMBER }}>{tr('startedByStaff')}</div>
            {draftLoaded && <div className="text-[10.5px] shrink-0" style={{ color: '#9CA3AF' }}>{fmtRelative(draftLoaded.updatedAt, lang)}</div>}
          </div>
          <div className="text-sm font-semibold mt-0.5" style={{ color: INK }}>
            {draftLoaded?.createdByName ? `${draftLoaded.createdByName} · ` : ''}{fmtItems(itemCount, lang)}
          </div>
          <button onClick={() => setCartExpanded(true)}
            className="mt-2.5 inline-flex items-center gap-1 text-sm font-bold rounded-full px-3.5 py-1.5 text-white" style={{ backgroundColor: NAVY }}>
            {tr('reviewConfirm')} <ChevronRight size={14} />
          </button>
        </div>
      )}

      <div className="bg-white rounded-2xl p-4 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('addProducts')}</div>
        {categories.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-0.5 px-0.5" style={{ WebkitOverflowScrolling: 'touch' }}>
            <button onClick={() => setCategoryFilter(null)}
              className="shrink-0 text-xs font-semibold rounded-full px-3 py-1.5"
              style={{ backgroundColor: !categoryFilter ? NAVY : 'white', color: !categoryFilter ? 'white' : INK, border: `1px solid ${BORDER}` }}>
              {tr('all')}
            </button>
            {categories.map(cat => (
              <button key={cat} onClick={() => setCategoryFilter(prev => prev === cat ? null : cat)}
                className="shrink-0 text-xs font-semibold rounded-full px-3 py-1.5"
                style={{ backgroundColor: categoryFilter === cat ? NAVY : 'white', color: categoryFilter === cat ? 'white' : INK, border: `1px solid ${BORDER}` }}>
                {cat}
              </button>
            ))}
          </div>
        )}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder={tr('searchPh')} className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: `1px solid ${BORDER}` }} />
        </div>
        {(searchQuery.trim().length >= 2 || categoryFilter) && (
          <div className="rounded-lg overflow-y-auto overscroll-contain max-h-72" style={{ border: `1px solid ${BORDER}`, WebkitOverflowScrolling: 'touch' }}>
            {searching ? (
              <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>{tr('loading')}</div>
            ) : !searchResults.length ? (
              <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>{lang === 'en' ? 'No results' : 'Không tìm thấy'}</div>
            ) : searchResults.map(p => {
              const qtyInCart = cart.find(l => l.sku === p.sku)?.qty ?? 0;
              return (
                <div key={p.sku} className="px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2.5" style={{ borderColor: CREAM }}>
                  {p.imageUrl ? (
                    <img src={thumb(p.imageUrl, 80)} alt="" className="shrink-0 w-10 h-10 rounded object-cover" />
                  ) : (
                    <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: CREAM }} />
                  )}
                  <span className="overflow-x-auto whitespace-nowrap no-scrollbar flex-1 min-w-0" style={{ WebkitOverflowScrolling: 'touch' }}>{p.name}<span style={{ color: '#9CA3AF' }}> · {p.sku}{p.isPackaging ? ' · packaging' : ''}</span></span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => setQtyForProduct(p, qtyInCart - 1)} disabled={qtyInCart <= 0}
                      className="w-6 h-6 rounded-md flex items-center justify-center disabled:opacity-30" style={{ border: `1px solid ${BORDER}` }}>
                      <Minus size={11} />
                    </button>
                    <span className="w-5 text-center text-xs font-bold">{qtyInCart}</span>
                    <button onClick={() => setQtyForProduct(p, qtyInCart + 1)}
                      className="w-6 h-6 rounded-md flex items-center justify-center" style={{ border: `1px solid ${BORDER}` }}>
                      <Plus size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl p-4 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('liveInventory')}</div>
          {invAsOf && (
            <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{tr('lastCount')} {fmtLastCount(invAsOf, lang)}</div>
          )}
        </div>
        {invLevels === null ? (
          <div className="text-xs py-2" style={{ color: '#9CA3AF' }}>{tr('loading')}</div>
        ) : !invLevels.length ? (
          <div className="text-xs py-2" style={{ color: '#9CA3AF' }}>{tr('noInvToday')}</div>
        ) : (
          <>
            <div className="flex rounded-lg p-0.5" style={{ border: `1px solid ${BORDER}` }}>
              {([['all', tr('all')], ['in', tr('inStock')], ['out', tr('outOfStock')]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setInvFilter(k)}
                  className="flex-1 text-center text-[11px] font-semibold rounded-md py-1.5"
                  style={{ backgroundColor: invFilter === k ? NAVY : 'transparent', color: invFilter === k ? 'white' : INK_LIGHT }}>
                  {label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
              <input type="text" value={invQuery} onChange={e => setInvQuery(e.target.value)}
                placeholder={tr('filterPh')} className="w-full rounded-lg pl-7 pr-2.5 py-1.5 text-xs" style={{ border: `1px solid ${BORDER}` }} />
            </div>
            <div className="rounded-lg overflow-y-auto overscroll-contain max-h-56" style={{ border: `1px solid ${CREAM}` }}>
              {invLevels
                .filter(l => invFilter === 'all' || (invFilter === 'in' ? l.qty > 0 : l.qty <= 0))
                .filter(l => !invQuery.trim() || l.name.toLowerCase().includes(invQuery.trim().toLowerCase()))
                .slice(0, 80)
                .map(l => (
                  <div key={l.sku} className="px-3 py-1.5 text-xs border-t first:border-t-0 flex items-center justify-between gap-2" style={{ borderColor: CREAM }}>
                    <div className="min-w-0 flex-1">
                      <div className="overflow-x-auto whitespace-nowrap no-scrollbar font-semibold" style={{ WebkitOverflowScrolling: 'touch', color: INK }}>{l.name}</div>
                      <div style={{ color: '#9CA3AF' }}>{l.qty > 0 ? (lang === 'en' ? `${l.qty} in stock` : `${l.qty} còn`) : tr('outOfStock')}</div>
                    </div>
                    <span className="shrink-0 font-bold rounded-full px-2 py-0.5 text-[10.5px]"
                      style={{ color: l.qty > 0 ? GREEN : RED, backgroundColor: l.qty > 0 ? '#EAF6EC' : '#FDECEC' }}>
                      {l.qty > 0 ? tr('inStock') : tr('outOfStock')}
                    </span>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>

      {cartExpanded && (
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          {!cart.length ? (
            <div className="p-6 text-center text-sm" style={{ color: '#9CA3AF' }}>{tr('emptyCart')}</div>
          ) : (
            <div className="divide-y" style={{ borderColor: CREAM }}>
              {cart.map(l => (
                <div key={l.sku} className="px-4 py-2.5 space-y-1.5">
                  <div className="flex items-center gap-2.5">
                    {l.imageUrl ? (
                      <img src={thumb(l.imageUrl, 80)} alt="" className="shrink-0 w-10 h-10 rounded object-cover" />
                    ) : (
                      <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: CREAM }} />
                    )}
                    <span className="text-sm font-semibold overflow-x-auto whitespace-nowrap no-scrollbar flex-1 min-w-0" style={{ WebkitOverflowScrolling: 'touch', color: INK }}>{l.name}</span>
                    <button onClick={() => removeItem(l.sku)} className="shrink-0"><Trash2 size={14} style={{ color: RED }} /></button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => updateQty(l.sku, l.qty - 1)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ border: `1px solid ${BORDER}` }}>
                      <Minus size={12} />
                    </button>
                    <input type="number" value={l.qty} onChange={e => updateQty(l.sku, Number(e.target.value))}
                      className="w-14 text-center rounded-lg py-1 text-sm font-bold shrink-0" style={{ border: `1px solid ${BORDER}` }} />
                    <button onClick={() => updateQty(l.sku, l.qty + 1)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ border: `1px solid ${BORDER}` }}>
                      <Plus size={12} />
                    </button>
                    <input type="text" value={l.note} onChange={e => updateNote(l.sku, e.target.value)}
                      placeholder={lang === 'en' ? 'Note (optional)' : 'Ghi chú (tuỳ chọn)'} className="flex-1 min-w-0 rounded-lg px-2.5 py-1 text-xs" style={{ border: `1px solid ${BORDER}` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {cartExpanded && cart.length > 0 && (
        <div className="flex gap-2">
          <button onClick={saveDraft} disabled={!cart.some(l => l.qty > 0) || !createdByName.trim() || draftSaving}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 disabled:opacity-40" style={{ border: `1px solid ${BORDER}`, color: INK }}>
            {draftSaving ? <Loader2 size={14} className="animate-spin" /> : null}{tr('saveDraft')}
          </button>
          <button onClick={discardDraft} className="text-sm font-bold rounded-lg px-3 py-2.5" style={{ color: RED }}>
            {tr('discardDraft')}
          </button>
        </div>
      )}
      {msg && <div className="text-xs font-semibold" style={{ color: RED }}>{msg}</div>}

      {/* Sticky checkout bar — above the bottom nav, always visible once there's something to
          order. No money total shown (see file header comment — not in the underlying data). */}
      {cart.length > 0 && (
        <div className="fixed left-0 right-0 z-10 px-4" style={{ bottom: 56 }}>
          <div className="max-w-xl mx-auto rounded-2xl px-4 py-3 flex items-center justify-between shadow-lg" style={{ backgroundColor: NAVY }}>
            <div className="text-sm font-bold text-white">{fmtItems(itemCount, lang)}</div>
            <button onClick={openConfirm} disabled={!itemCount || submitting}
              className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-4 py-2 disabled:opacity-40" style={{ backgroundColor: GOLD, color: NAVY }}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {tr('confirmOrder')}
            </button>
          </div>
        </div>
      )}

      {pendingConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('confirmOrder')} ({itemCount})</div>
            <div className="text-xs" style={{ color: INK_LIGHT }}>
              {tr('delivery')}: {deliveryDate ? fmtDate(deliveryDate, lang) : '…'}{deliveryTime ? ` · ${deliveryTime}` : ''}
            </div>
            <div className="space-y-1.5">
              {cart.filter(l => l.qty > 0).map(l => (
                <div key={l.sku} className="flex items-center gap-2.5 rounded-xl p-2.5" style={{ backgroundColor: CREAM }}>
                  {l.imageUrl ? (
                    <img src={thumb(l.imageUrl, 80)} alt="" className="shrink-0 w-8 h-8 rounded object-cover" />
                  ) : (
                    <div className="shrink-0 w-8 h-8 rounded" style={{ backgroundColor: '#E5E7EB' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', color: INK }}>{l.name}</div>
                    {l.note.trim() && <div className="text-xs" style={{ color: '#9CA3AF' }}>{l.note.trim()}</div>}
                  </div>
                  <span className="text-sm font-bold shrink-0">×{l.qty}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: INK_LIGHT }}>{tr('pinLabel')}</div>
              <input type="password" inputMode="numeric" value={confirmPin} onChange={e => setConfirmPin(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmOrder(); }}
                placeholder={tr('pinPh')} autoFocus
                className="w-full text-center tracking-[0.3em] rounded-lg px-3 py-2.5 text-lg font-bold" style={{ border: `1px solid ${BORDER}` }} />
              {confirmMsg && <div className="text-xs font-semibold mt-1.5" style={{ color: RED }}>{confirmMsg}</div>}
            </div>
            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{tr('pinNote')}</div>
            <div className="flex gap-2">
              <button onClick={() => { setPendingConfirm(false); setConfirmPin(''); setConfirmMsg(null); }}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: `1px solid ${BORDER}`, color: INK }}>
                {tr('cancel')}
              </button>
              <button onClick={confirmOrder} disabled={submitting || !confirmPin.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
                {submitting ? <Loader2 size={14} className="animate-spin" /> : null}{tr('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
