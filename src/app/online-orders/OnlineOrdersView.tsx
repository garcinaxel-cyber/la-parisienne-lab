'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Plus, Minus, X, Loader2, Bell, Settings, CalendarDays, LogOut } from 'lucide-react';
import { SHOP_NAMES_ALL } from '@/lib/shops';
import { HANOI_DISTRICTS } from '@/lib/hanoi-districts';
import { thumb } from '@/lib/img-thumb';
import { pushSupport, getExistingPushSubscription, requestPushSubscription, unsubscribeCurrentPush } from '@/lib/push-client';
import * as actions from './actions';
import type { OnlineProduct, OnlineOrderItem, OnlineOrderSummary, OnlineAnalytics, ExtraFeeType, ChannelProductDetail } from './actions';
import CustomersTab from './CustomersTab';
import InboxTab, { type InboxOrderPrefill } from './InboxTab';
import OrdersTab from './OrdersTab';
import { UI_THEMES, applyUiTheme, readUiTheme, type UiThemeId } from '@/lib/ui-theme';
import { NAVY, GOLD, CREAM, CREAM_DARK, INK, INK_LIGHT, BORDER, TABBAR, fmtVnd, fmtDayLabel, fmtCompactVnd, useL } from './shared';

// Shops that can handle an online order. 'Lab' (Axel, 2026-10-10) is offered for Lab orders only,
// as the last choice: same process as a manual order delivered by the Lab (quotation on the LAB
// partner, renamed by the assistants in Odoo, Lab delivers straight to the customer). Shop-stock
// sales stay shop-only -- there is no stock count for the Lab.
const ONLINE_SHOPS = SHOP_NAMES_ALL.filter(s => s !== 'Lab');
const LAB_SHOP = 'Lab';

import { compressImage } from './order-widgets';

type CartLine = OnlineOrderItem & { key: string; nameVi: string; imageUrl: string | null; isCake: boolean; listPrice: number | null };
// Same rounding as the server's netUnitPrice (online-orders/actions.ts).
function netPrice(gross: number, pct: number): number {
  return pct > 0 ? Math.round(gross * (100 - Math.min(100, pct)) / 100) : gross;
}
type Tab = 'inbox' | 'order' | 'track' | 'stats' | 'customers';

export default function OnlineOrdersView({ fullName, isAdmin, readOnly = false }: { fullName: string; isAdmin: boolean; readOnly?: boolean }) {
  const { tr } = useL();
  const [tab, setTab] = useState<Tab>(readOnly ? 'track' : 'order');
  // Messenger inbox (Axel, 2026-10-27) — visible to admin only while it is being tested; the
  // online-sales team keeps the current tabs until Axel switches it on for them.
  // Tin nhắn tab: online sales + admins (opened to the team 2026-10-28). Shop managers don't see it.
  const showInbox = !readOnly;
  const [inboxUnread, setInboxUnread] = useState(0);
  // Badge on the tab while she is on another tab: one tiny count query per minute.
  useEffect(() => {
    if (!showInbox || tab === 'inbox') return;
    let alive = true;
    const tick = () => import('./inbox-actions').then(m => m.getInboxUnreadCountAction()).then(r => { if (alive && typeof r.count === 'number') setInboxUnread(r.count); });
    tick();
    const t = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [showInbox, tab]);
  const today = new Date().toISOString().slice(0, 10);
  // ── Order form state ──
  const [shop, setShop] = useState(ONLINE_SHOPS[0]);
  // 'lab' = existing flow (Odoo doc + production card); 'shop_stock' = sale served from the shop's
  // own shelf — records only, zero Odoo/production (Axel, 2026-09-07).
  const [source, setSource] = useState<'lab' | 'shop_stock'>('lab');
  const [channel, setChannel] = useState('');
  const [channels, setChannels] = useState<string[]>([]);
  const [newChannel, setNewChannel] = useState('');
  async function loadChannels() {
    const res = await actions.listOnlineChannelsAction();
    if (res.channels) setChannels(res.channels);
  }
  useEffect(() => { loadChannels(); }, []);
  async function addChannel() {
    const n = newChannel.trim();
    if (!n) return;
    await actions.addOnlineChannelAction(n);
    setNewChannel(''); setChannel(n); loadChannels();
  }
  async function deleteChannel(n: string) {
    await actions.deleteOnlineChannelAction(n);
    if (channel === n) setChannel('');
    loadChannels();
  }
  // ── Extra fees (nến, nón...) — shared list, never touches Odoo/production (lab_v75) ──
  const [feeTypes, setFeeTypes] = useState<ExtraFeeType[]>([]);
  async function loadFeeTypes() {
    const res = await actions.listExtraFeeTypesAction();
    if (res.fees) setFeeTypes(res.fees);
  }
  useEffect(() => { loadFeeTypes(); }, []);
  type FeeLine = { key: string; feeTypeId: string | null; emoji: string | null; label: string; qty: number; unitPrice: number };
  const [feeCart, setFeeCart] = useState<FeeLine[]>([]);
  function addFeeToCart(f: ExtraFeeType) {
    setFeeCart(prev => {
      const existing = prev.find(l => l.feeTypeId === f.id);
      if (existing) return prev.map(l => l.feeTypeId === f.id ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, { key: f.id, feeTypeId: f.id, emoji: f.emoji, label: f.label, qty: 1, unitPrice: f.defaultPrice }];
    });
  }
  function updateFeeLine(key: string, patch: Partial<FeeLine>) {
    setFeeCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function removeFeeLine(key: string) {
    setFeeCart(prev => prev.filter(l => l.key !== key));
  }
  const [manageFeesOpen, setManageFeesOpen] = useState(false);
  const [newFeeEmoji, setNewFeeEmoji] = useState('🎁');
  const [newFeeLabel, setNewFeeLabel] = useState('');
  const [newFeePrice, setNewFeePrice] = useState('');
  async function addFeeType() {
    const label = newFeeLabel.trim();
    if (!label) return;
    await actions.addExtraFeeTypeAction({ emoji: newFeeEmoji.trim() || null, label, defaultPrice: Number(newFeePrice) || 0 });
    setNewFeeLabel(''); setNewFeePrice(''); loadFeeTypes();
  }
  async function updateFeeTypePrice(id: string, price: number) {
    setFeeTypes(prev => prev.map(f => f.id === id ? { ...f, defaultPrice: price } : f));
    await actions.updateExtraFeeTypeAction({ id, defaultPrice: price });
  }
  async function updateFeeTypeLabel(id: string, label: string) {
    setFeeTypes(prev => prev.map(f => f.id === id ? { ...f, label } : f));
    await actions.updateExtraFeeTypeAction({ id, label });
  }
  async function deleteFeeType(id: string) {
    setFeeTypes(prev => prev.filter(f => f.id !== id));
    setFeeCart(prev => prev.filter(l => l.feeTypeId !== id));
    await actions.deleteExtraFeeTypeAction(id);
  }

  const [deliveryDate, setDeliveryDate] = useState(today);
  const [readyTime, setReadyTime] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [district, setDistrict] = useState('');
  // 'shop' (default, existing behaviour) or 'direct' — who delivers to the end customer
  // (Axel, 2026-09-09). Only meaningful for source==='lab'; ignored for shop_stock sales.
  const [deliveryMode, setDeliveryMode] = useState<'shop' | 'direct'>('shop');
  const [notes, setNotes] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('0');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid' | 'partial'>('unpaid');
  const [amountPaid, setAmountPaid] = useState('0');
  // Discounts (Axel, 2026-10-09) — per line % lives on each CartLine (discountPct); the order
  // discount (% or ₫) and its mandatory reason live here. Same rounding as the server's
  // netUnitPrice / orderDiscountAmount so the total she sees is the total that gets saved.
  const [orderDiscKind, setOrderDiscKind] = useState<'pct' | 'amount'>('pct');
  const [orderDiscValue, setOrderDiscValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Set when the form was opened from a Messenger conversation ("Tạo đơn"): the order created next
  // is linked to that conversation (auto tag + Meta chat purchase). Cleared after one order.
  const [inboxLink, setInboxLink] = useState<{ conversationId: string; customerName: string; pageName: string } | null>(null);
  const [submitMsg, setSubmitMsg] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    // Empty query = closed list (Axel, 2026-09-06: the dropdown used to list the whole catalogue
    // and there was no way out of it). Results only appear once she types, and close on
    // Escape / tap outside / pick.
    if (!query.trim()) { setResults([]); setSearching(false); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await actions.searchOnlineProductsAction(query);
      setResults(res.products ?? []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function addToCart(p: OnlineProduct) {
    const key = `${p.ficheId}:${p.variantId ?? ''}`;
    setCart(prev => {
      const existing = prev.find(l => l.key === key);
      if (existing) return prev.map(l => l.key === key ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, {
        key, ficheId: p.ficheId, variantId: p.variantId, qty: 1, unitPrice: p.price ?? 0,
        message: null, designNotes: null, designPhotoUrl: null, lineNote: null,
        nameVi: p.nameVi, imageUrl: p.imageUrl, isCake: p.isCake, listPrice: p.price,
      }];
    });
    setQuery(''); setResults([]); setSearchOpen(false);
  }
  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function removeLine(key: string) {
    setCart(prev => prev.filter(l => l.key !== key));
  }
  async function onDesignPhoto(key: string, file: File) {
    const fd = new FormData(); fd.append('file', await compressImage(file));
    const res = await actions.uploadOnlineDesignPhotoAction(fd);
    if (res.url) updateLine(key, { designPhotoUrl: res.url });
  }

  const cartGross = useMemo(() => cart.reduce((s, l) => s + l.qty * (Number(l.unitPrice) || 0), 0), [cart]);
  const cartTotal = useMemo(() => cart.reduce((s, l) => s + l.qty * netPrice(Number(l.unitPrice) || 0, Number(l.discountPct) || 0), 0), [cart]);
  const lineDiscountTotal = cartGross - cartTotal;
  const orderDiscountAmt = useMemo(() => {
    const v = Number(orderDiscValue);
    if (!Number.isFinite(v) || v <= 0 || cartTotal <= 0) return 0;
    const amt = orderDiscKind === 'pct' ? Math.round(cartTotal * Math.min(100, v) / 100) : Math.round(v);
    return Math.max(0, Math.min(cartTotal, amt));
  }, [orderDiscKind, orderDiscValue, cartTotal]);
  const hasDiscount = lineDiscountTotal > 0 || orderDiscountAmt > 0;
  const feesTotal = useMemo(() => feeCart.reduce((s, l) => s + l.qty * (Number(l.unitPrice) || 0), 0), [feeCart]);
  const grandTotal = cartTotal - orderDiscountAmt + feesTotal + (Number(deliveryFee) || 0);

  async function handleSubmit() {
    if (!channel.trim()) { setSubmitMsg({ kind: 'error', text: tr('errChannel') }); return; }
    if (!cart.length) { setSubmitMsg({ kind: 'error', text: tr('errEmpty') }); return; }
    if (hasDiscount && !discountReason.trim()) { setSubmitMsg({ kind: 'error', text: tr('errDiscountReason') }); return; }
    if (source === 'lab' && shop === LAB_SHOP && (!customerName.trim() || !customerPhone.trim() || !deliveryAddress.trim() || !readyTime)) {
      setSubmitMsg({ kind: 'error', text: tr('errLabDirect') }); return;
    }
    const orderDiscount = orderDiscountAmt > 0 ? { kind: orderDiscKind, value: Number(orderDiscValue) } : null;
    const discountFields = { orderDiscount, discountReason: hasDiscount ? discountReason.trim() : null };
    setSubmitting(true); setSubmitMsg(null);
    const link = inboxLink;
    const linkInfo = { value: grandTotal, phone: customerPhone || null, name: customerName || null };
    const linkOrder = (orderBatchId: string | undefined, src: 'lab' | 'shop_stock') => {
      if (!link || !orderBatchId) return;
      import('./inbox-actions').then(m => m.linkInboxOrderAction({ conversationId: link.conversationId, orderBatchId, source: src, ...linkInfo })).catch(() => {});
      setInboxLink(null);
    };
    if (source === 'shop_stock') {
      const res = await actions.submitShopStockSaleAction({
        shop, channel: channel.trim(), saleDate: deliveryDate,
        customerName: customerName || null, customerPhone: customerPhone || null,
        deliveryAddress: deliveryAddress || null, district: district || null, notes: notes || null,
        deliveryFee: Number(deliveryFee) || 0, paymentStatus, amountPaid: Number(amountPaid) || 0,
        items: cart.map(l => ({ ficheId: l.ficheId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, lineNote: l.lineNote ?? null, discountPct: Number(l.discountPct) || null })),
        fees: feeCart.map(l => ({ emoji: l.emoji, label: l.label, qty: l.qty, unitPrice: l.unitPrice })),
        ...discountFields,
      });
      setSubmitting(false);
      if (res.error) { setSubmitMsg({ kind: 'error', text: res.error }); return; }
      setSubmitMsg({ kind: 'ok', text: tr('okStock') });
      linkOrder(res.orderBatchId, 'shop_stock');
    } else {
      const res = await actions.submitOnlineOrderAction({
        shop, channel: channel.trim(), deliveryDate, readyTime: readyTime || null,
        customerName: customerName || null, customerPhone: customerPhone || null,
        deliveryAddress: deliveryAddress || null, district: district || null, notes: notes || null,
        deliveryFee: Number(deliveryFee) || 0, paymentStatus, amountPaid: Number(amountPaid) || 0,
        deliveryMode: shop === LAB_SHOP ? 'direct' : deliveryMode,
        items: cart.map(({ key, nameVi, imageUrl, isCake, listPrice, ...rest }) => ({ ...rest, discountPct: Number(rest.discountPct) || null })),
        fees: feeCart.map(l => ({ emoji: l.emoji, label: l.label, qty: l.qty, unitPrice: l.unitPrice })),
        ...discountFields,
      });
      setSubmitting(false);
      if (res.error) { setSubmitMsg({ kind: 'error', text: res.error }); return; }
      linkOrder(res.orderBatchId, 'lab');
      if (res.warning) { setSubmitMsg({ kind: 'warn', text: res.warning }); }
      else setSubmitMsg({ kind: 'ok', text: res.orderRef ? `${tr('okOdoo')}${res.orderRef}` : tr('okSaved') });
    }
    setCart([]); setFeeCart([]); setChannel(''); setCustomerName(''); setCustomerPhone(''); setDeliveryAddress(''); setDistrict(''); setNotes(''); setDeliveryMode('shop');
    setDeliveryFee('0'); setPaymentStatus('unpaid'); setAmountPaid('0');
    setOrderDiscKind('pct'); setOrderDiscValue(''); setDiscountReason('');
  }

  // "Tạo đơn" from a Messenger conversation: pre-fill the normal order form (nothing else changes —
  // Lab / shop-stock choice, Odoo, delivery all stay exactly the existing flow).
  function prefillFromInbox(p: InboxOrderPrefill) {
    if (p.customerName) setCustomerName(p.customerName);
    if (p.customerPhone) setCustomerPhone(p.customerPhone);
    if (p.deliveryAddress) setDeliveryAddress(p.deliveryAddress);
    if (p.district) setDistrict(p.district);
    if (p.channel) setChannel(p.channel);
    setInboxLink({ conversationId: p.conversationId, customerName: p.customerName, pageName: p.pageName });
    setSubmitMsg(null);
    setTab('order');
  }

  // Staff colour theme (same 4 themes and the same per-browser storage as the chefs' screens).
  const [uiTheme, setUiTheme] = useState<UiThemeId>('ivoire');
  useEffect(() => { const t = readUiTheme(); setUiTheme(t); applyUiTheme(t); }, []);
  const pickTheme = (t: UiThemeId) => { setUiTheme(t); applyUiTheme(t, true); };

  const goNewOrder = () => { setSubmitMsg(null); setTab('order'); };
  const isInbox = tab === 'inbox' && showInbox;
  return (
    <div className={isInbox ? 'h-[100dvh] overflow-hidden' : 'min-h-screen'} style={{ backgroundColor: CREAM }}>
      <Sidebar fullName={fullName} tab={tab} setTab={setTab} readOnly={readOnly} showInbox={showInbox} inboxUnread={inboxUnread} uiTheme={uiTheme} pickTheme={pickTheme} />
      <div className={`lg:pl-56 flex flex-col ${isInbox ? 'h-full' : tab === 'track' ? 'min-h-screen lg:h-[100dvh]' : 'min-h-screen'}`}>
        <Header fullName={fullName} count={cart.length} tab={tab} uiTheme={uiTheme} pickTheme={pickTheme} />
        {isInbox ? (
          <div className="flex-1 min-h-0 pb-[58px] lg:pb-0">
            <InboxTab readOnly={readOnly} onCreateOrder={prefillFromInbox} onUnreadChange={setInboxUnread} />
          </div>
        ) : tab === 'track' ? (
          <div className="flex-1 lg:min-h-0">
            <OrdersTab readOnly={readOnly} onNewOrder={readOnly ? undefined : goNewOrder} />
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto pb-24 lg:pb-8">
          <div className={`mx-auto px-4 py-4 lg:py-6 ${tab === 'order' ? 'max-w-xl lg:max-w-2xl' : 'max-w-xl lg:max-w-3xl'}`}>
            {tab === 'order' && !readOnly && inboxLink && (
              <div className="flex items-center gap-2 mb-3" style={{ fontSize: 12.5, color: '#1F6B45', backgroundColor: '#EAF2EC', border: '1px solid #C9D9CF', borderRadius: 10, padding: '8px 12px' }}>
                <span className="flex-1">💬 {tr('inboxLinkedTo')} <b>{inboxLink.customerName || '—'}</b> · {inboxLink.pageName}</span>
                <button onClick={() => setInboxLink(null)} style={{ fontSize: 12, fontWeight: 600, color: '#8A6D14' }}>{tr('inboxUnlink')}</button>
              </div>
            )}
            {tab === 'order' && !readOnly && (
              <OrderTab
                source={source} setSource={setSource}
                shop={shop} setShop={setShop} channel={channel} setChannel={setChannel}
                channels={channels} newChannel={newChannel} setNewChannel={setNewChannel} addChannel={addChannel} deleteChannel={deleteChannel}
                deliveryDate={deliveryDate} setDeliveryDate={setDeliveryDate}
                readyTime={readyTime} setReadyTime={setReadyTime}
                customerName={customerName} setCustomerName={setCustomerName}
                customerPhone={customerPhone} setCustomerPhone={setCustomerPhone}
                deliveryAddress={deliveryAddress} setDeliveryAddress={setDeliveryAddress}
                district={district} setDistrict={setDistrict}
                deliveryMode={deliveryMode} setDeliveryMode={setDeliveryMode}
                notes={notes} setNotes={setNotes}
                deliveryFee={deliveryFee} setDeliveryFee={setDeliveryFee}
                paymentStatus={paymentStatus} setPaymentStatus={setPaymentStatus}
                amountPaid={amountPaid} setAmountPaid={setAmountPaid}
                cart={cart} updateLine={updateLine} removeLine={removeLine} onDesignPhoto={onDesignPhoto}
                query={query} setQuery={setQuery} results={results} searching={searching} addToCart={addToCart}
                searchOpen={searchOpen} setSearchOpen={setSearchOpen}
                feeTypes={feeTypes} feeCart={feeCart} addFeeToCart={addFeeToCart} updateFeeLine={updateFeeLine} removeFeeLine={removeFeeLine}
                manageFeesOpen={manageFeesOpen} setManageFeesOpen={setManageFeesOpen}
                newFeeEmoji={newFeeEmoji} setNewFeeEmoji={setNewFeeEmoji} newFeeLabel={newFeeLabel} setNewFeeLabel={setNewFeeLabel}
                newFeePrice={newFeePrice} setNewFeePrice={setNewFeePrice} addFeeType={addFeeType}
                updateFeeTypePrice={updateFeeTypePrice} updateFeeTypeLabel={updateFeeTypeLabel} deleteFeeType={deleteFeeType}
                cartTotal={cartTotal} feesTotal={feesTotal} grandTotal={grandTotal}
                cartGross={cartGross} lineDiscountTotal={lineDiscountTotal} orderDiscountAmt={orderDiscountAmt} hasDiscount={hasDiscount}
                orderDiscKind={orderDiscKind} setOrderDiscKind={setOrderDiscKind} orderDiscValue={orderDiscValue} setOrderDiscValue={setOrderDiscValue}
                discountReason={discountReason} setDiscountReason={setDiscountReason}
                submitting={submitting} submitMsg={submitMsg} onSubmit={handleSubmit}
              />
            )}
            {tab === 'stats' && <StatsTab />}
            {tab === 'customers' && <CustomersTab />}
          </div>
        </div>
        )}
      </div>
      <TabBar tab={tab} setTab={setTab} readOnly={readOnly} showInbox={showInbox} inboxUnread={inboxUnread} />
    </div>
  );
}

// Bell / language / logout, shared by the phone header and the desktop sidebar.
function useAccountControls() {
  const { tr } = useL();
  const router = useRouter();
  const [bellState, setBellState] = useState<'off' | 'on' | 'busy'>('off');
  useEffect(() => {
    getExistingPushSubscription().then(sub => setBellState(sub ? 'on' : 'off'));
  }, []);
  // Axel, 2026-09-08: this page is its own top-level route (not under the admin Sidebar), so an
  // admin who opens it to check on online sales had no way back except clearing cookies -- add an
  // explicit sign-out here, same signOut()+redirect pattern as Sidebar/ShopView/StationView.
  async function logout() {
    if (!window.confirm(tr('logoutConfirm'))) return;
    const { createClient } = await import('@/lib/supabase-browser');
    await createClient().auth.signOut();
    router.push('/login');
  }
  async function toggleBell() {
    if (bellState === 'busy') return;
    setBellState('busy');
    if (bellState === 'on') {
      const endpoint = await unsubscribeCurrentPush();
      if (endpoint) await actions.unsubscribeOnlinePushAction(endpoint);
      setBellState('off');
      return;
    }
    const result = await requestPushSubscription();
    if (result.ok) { await actions.subscribeOnlinePushAction(result.subscription); setBellState('on'); }
    else setBellState('off');
  }
  return { bellState, toggleBell, logout };
}

function ThemeSwatches({ uiTheme, pickTheme, size = 26 }: { uiTheme: UiThemeId; pickTheme: (t: UiThemeId) => void; size?: number }) {
  const { lang } = useL();
  return (
    <div className="flex items-center gap-2">
      {UI_THEMES.map(th => (
        <button key={th.id} onClick={() => pickTheme(th.id)} aria-pressed={uiTheme === th.id} title={lang === 'en' ? th.en : th.vi} aria-label={lang === 'en' ? th.en : th.vi}
          style={{ width: size, height: size, borderRadius: size / 2, background: `linear-gradient(135deg, ${th.swatch[0]} 50%, ${th.swatch[2]} 50%)`, outline: uiTheme === th.id ? '2px solid #FBF7F0' : '1px solid rgba(255,255,255,0.15)', outlineOffset: uiTheme === th.id ? 2 : 0 }} />
      ))}
    </div>
  );
}

function navItems(tr: (k: any) => string, readOnly: boolean, showInbox: boolean) {
  return [
    ...(showInbox ? [{ key: 'inbox' as Tab, icon: '💬', label: tr('tabInbox') }] : []),
    { key: 'track' as Tab, icon: '📦', label: tr('navOrders') },
    ...(readOnly ? [] : [{ key: 'order' as Tab, icon: '＋', label: tr('navNew') }]),
    { key: 'customers' as Tab, icon: '👥', label: tr('tabCustomers') },
    { key: 'stats' as Tab, icon: '📊', label: tr('tabStats') },
  ];
}

function Sidebar({ fullName, tab, setTab, readOnly, showInbox, inboxUnread, uiTheme, pickTheme }: { fullName: string; tab: Tab; setTab: (t: Tab) => void; readOnly: boolean; showInbox: boolean; inboxUnread: number; uiTheme: UiThemeId; pickTheme: (t: UiThemeId) => void }) {
  const { tr, lang, setLang } = useL();
  const { bellState, toggleBell, logout } = useAccountControls();
  return (
    <aside className="hidden lg:flex fixed left-0 top-0 bottom-0 w-56 z-20 flex-col gap-6 px-3.5 py-5" style={{ backgroundColor: NAVY, color: '#E8DCCB' }}>
      <div className="px-2.5 flex flex-col gap-0.5">
        <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 22, fontWeight: 700, color: '#FBF7F0' }}>La Paris</div>
        <div style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#D9C48A', fontWeight: 600 }}>Online sales</div>
      </div>
      <nav className="flex flex-col gap-1" aria-label="Main">
        {navItems(tr, readOnly, showInbox).map(it => {
          const on = tab === it.key;
          return (
            <button key={it.key} onClick={() => setTab(it.key)} className="flex items-center justify-between text-left"
              style={{ minHeight: 42, borderRadius: 10, padding: '0 12px', fontSize: 14, fontWeight: on ? 700 : 500, color: on ? NAVY : '#E8DCCB', backgroundColor: on ? '#F6F1EA' : 'transparent' }}>
              <span className="flex items-center gap-3"><span style={{ width: 18, textAlign: 'center' }}>{it.icon}</span>{it.label}</span>
              {it.key === 'inbox' && inboxUnread > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px', backgroundColor: on ? NAVY : '#9A3324', color: '#FBF7F0' }}>{inboxUnread > 99 ? '99+' : inboxUnread}</span>}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-4 px-2">
        <div className="flex flex-col gap-2">
          <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#D9C48A', fontWeight: 700 }}>{tr('colours')}</span>
          <ThemeSwatches uiTheme={uiTheme} pickTheme={pickTheme} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.25)' }} aria-label="Language">
            {(['vi', 'en'] as const).map(lg => (
              <button key={lg} onClick={() => setLang(lg)} style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', backgroundColor: lang === lg ? GOLD : 'transparent', color: lang === lg ? NAVY : 'rgba(255,255,255,0.7)' }}>{lg.toUpperCase()}</button>
            ))}
          </div>
          {pushSupport() !== 'unsupported' && (
            <button onClick={toggleBell} style={{ color: bellState === 'on' ? GOLD : 'rgba(255,255,255,0.5)', marginLeft: 'auto' }} aria-label={tr('bell')}>
              {bellState === 'busy' ? <Loader2 size={17} className="animate-spin" /> : <Bell size={17} fill={bellState === 'on' ? GOLD : 'none'} />}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center flex-none" style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#572C1A', color: '#FBF7F0', fontSize: 12, fontWeight: 700 }}>{(fullName || '?').trim().split(/\s+/).pop()?.[0]?.toUpperCase()}</div>
          <div className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>{fullName}</div>
          <button onClick={logout} title={tr('logout')} aria-label={tr('logout')} style={{ color: 'rgba(255,255,255,0.55)' }}><LogOut size={16} /></button>
        </div>
      </div>
    </aside>
  );
}

function Header({ fullName, count, tab, uiTheme, pickTheme }: { fullName: string; count: number; tab: Tab; uiTheme: UiThemeId; pickTheme: (t: UiThemeId) => void }) {
  const { tr, lang, setLang } = useL();
  const { bellState, toggleBell, logout } = useAccountControls();
  const [themeOpen, setThemeOpen] = useState(false);
  const dateLabel = new Date().toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const titles: Record<Tab, string> = { inbox: tr('titleInbox'), order: tr('titleOrder'), track: tr('navOrders'), stats: tr('titleStats'), customers: tr('titleCustomers') };
  return (
    <div style={{ backgroundColor: NAVY, color: '#FBF7F0' }} className="lg:hidden px-4 pt-3.5 pb-3 sticky top-0 z-10">
      <div className="flex items-center gap-2.5">
        <div className="flex-1 min-w-0">
          <div style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 18, lineHeight: 1.15 }}>{titles[tab]}</div>
          <div style={{ fontSize: 11, color: '#E9D3A4', marginTop: 1 }} className="truncate">{dateLabel}{fullName ? ` · ${fullName}` : ''}</div>
        </div>
        {tab === 'order' && count > 0 && (
          <div style={{ backgroundColor: GOLD, color: NAVY, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999 }}>{count} {tr('items')}</div>
        )}
        <button onClick={() => setThemeOpen(v => !v)} aria-label={tr('colours')} style={{ fontSize: 16, lineHeight: 1 }}>🎨</button>
        {pushSupport() !== 'unsupported' && (
          <button onClick={toggleBell} style={{ color: bellState === 'on' ? GOLD : 'rgba(255,255,255,0.5)' }} aria-label={tr('bell')}>
            {bellState === 'busy' ? <Loader2 size={18} className="animate-spin" /> : <Bell size={18} fill={bellState === 'on' ? GOLD : 'none'} />}
          </button>
        )}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.25)' }} aria-label="Language">
          {(['vi', 'en'] as const).map(lg => (
            <button key={lg} onClick={() => setLang(lg)} style={{
              fontSize: 10.5, fontWeight: 700, padding: '3px 7px', letterSpacing: '.03em',
              backgroundColor: lang === lg ? GOLD : 'transparent', color: lang === lg ? NAVY : 'rgba(255,255,255,0.7)',
            }}>{lg.toUpperCase()}</button>
          ))}
        </div>
        <button onClick={logout} title={tr('logout')} aria-label={tr('logout')} style={{ color: 'rgba(255,255,255,0.6)' }}>
          <LogOut size={18} />
        </button>
      </div>
      {themeOpen && (
        <div className="flex items-center gap-3 mt-3" style={{ fontSize: 12, color: '#E9D3A4' }}>
          <span>{tr('colours')}</span>
          <ThemeSwatches uiTheme={uiTheme} pickTheme={t => { pickTheme(t); setThemeOpen(false); }} size={30} />
        </div>
      )}
    </div>
  );
}

function TabBar({ tab, setTab, readOnly = false, showInbox = false, inboxUnread = 0 }: { tab: Tab; setTab: (t: Tab) => void; readOnly?: boolean; showInbox?: boolean; inboxUnread?: number }) {
  const { tr } = useL();
  const items = navItems(tr, readOnly, showInbox);
  return (
    <div className="lg:hidden flex items-end fixed bottom-0 left-0 right-0 z-10" style={{ backgroundColor: '#FFFFFF', borderTop: '1px solid #E6DCCF', paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}>
      {items.map(it => {
        const on = tab === it.key;
        if (it.key === 'order') return (
          <button key={it.key} onClick={() => setTab('order')} aria-label={it.label} className="flex-1 flex justify-center">
            <span className="flex items-center justify-center" style={{ width: 50, height: 50, borderRadius: 25, marginTop: -16, marginBottom: 4, backgroundColor: on ? GOLD : NAVY, color: on ? NAVY : '#FBF7F0', fontSize: 26, boxShadow: '0 6px 16px rgba(42,24,16,0.25)' }}>+</span>
          </button>
        );
        return (
          <button key={it.key} onClick={() => setTab(it.key)} className="flex-1 text-center pt-2 pb-1 relative"
            style={{ color: on ? NAVY : '#8A7A66', fontWeight: on ? 700 : 500, fontSize: 11 }}>
            <div className="relative w-fit mx-auto" style={{ fontSize: 17, opacity: on ? 1 : 0.75 }}>{it.icon}
              {it.key === 'inbox' && inboxUnread > 0 && (
                <span className="absolute -top-1 -right-3" style={{ backgroundColor: '#9A3324', color: '#fff', fontSize: 9.5, fontWeight: 700, borderRadius: 8, padding: '0 5px', lineHeight: '15px' }}>{inboxUnread > 99 ? '99+' : inboxUnread}</span>
              )}
            </div>{it.label}
            {on && <span style={{ position: 'absolute', top: 0, left: '30%', right: '30%', height: 2, backgroundColor: GOLD, borderRadius: 2 }} />}
          </button>
        );
      })}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{children}</div>;
}

function OrderTab(props: any) {
  const {
    source, setSource,
    shop, setShop, channel, setChannel, channels, newChannel, setNewChannel, addChannel, deleteChannel,
    deliveryDate, setDeliveryDate, readyTime, setReadyTime,
    customerName, setCustomerName, customerPhone, setCustomerPhone, deliveryAddress, setDeliveryAddress, district, setDistrict, deliveryMode, setDeliveryMode,
    notes, setNotes, deliveryFee, setDeliveryFee, paymentStatus, setPaymentStatus, amountPaid, setAmountPaid,
    cart, updateLine, removeLine, onDesignPhoto, query, setQuery, results, searching, addToCart, searchOpen, setSearchOpen,
    feeTypes, feeCart, addFeeToCart, updateFeeLine, removeFeeLine, manageFeesOpen, setManageFeesOpen,
    newFeeEmoji, setNewFeeEmoji, newFeeLabel, setNewFeeLabel, newFeePrice, setNewFeePrice, addFeeType,
    updateFeeTypePrice, updateFeeTypeLabel, deleteFeeType,
    cartTotal, feesTotal, grandTotal, submitting, submitMsg, onSubmit,
    cartGross, lineDiscountTotal, orderDiscountAmt, hasDiscount,
    orderDiscKind, setOrderDiscKind, orderDiscValue, setOrderDiscValue, discountReason, setDiscountReason,
  } = props;
  const { tr } = useL();

  const isStock = source === 'shop_stock';
  return (
    <div>
      <SectionLabel>{tr('sourceLabel')}</SectionLabel>
      <div className="grid grid-cols-2 gap-2 mb-1.5">
        {([['lab', tr('srcLab')], ['shop_stock', tr('srcStock')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setSource(k); if (k === 'shop_stock' && shop === LAB_SHOP) setShop(ONLINE_SHOPS[0]); }}
            style={{
              backgroundColor: source === k ? (k === 'shop_stock' ? '#B45309' : NAVY) : '#fff',
              color: source === k ? '#FBF7F0' : INK, border: source === k ? 'none' : `1px solid ${BORDER}`,
              fontSize: 12.5, fontWeight: source === k ? 700 : 500, padding: '9px 8px', borderRadius: 10,
            }}>{label}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: isStock ? '#B45309' : INK_LIGHT, marginBottom: 16, fontWeight: isStock ? 600 : 400 }}>
        {isStock ? tr('srcStockHint') : tr('srcLabHint')}
      </div>

      <SectionLabel>{tr('channelLabel')}</SectionLabel>
      <div className="flex flex-wrap gap-2 mb-2">
        {channels.map((c: string) => (
          <span key={c} className="inline-flex items-center rounded-full overflow-hidden"
            style={{ border: channel === c ? 'none' : `1px solid ${BORDER}`, backgroundColor: channel === c ? NAVY : '#fff' }}>
            <button onClick={() => setChannel(c)}
              style={{ color: channel === c ? '#FBF7F0' : INK, fontSize: 12.5, fontWeight: channel === c ? 600 : 500, padding: '7px 6px 7px 14px' }}>{c}</button>
            <button onClick={() => deleteChannel(c)} aria-label="remove"
              style={{ color: channel === c ? '#E9D3A4' : INK_LIGHT, padding: '7px 9px 7px 3px', lineHeight: 0 }}><X size={11} /></button>
          </span>
        ))}
        <span className="inline-flex items-center rounded-full" style={{ border: `1px dashed ${BORDER}`, backgroundColor: '#fff' }}>
          <input value={newChannel} onChange={(e: any) => setNewChannel(e.target.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') { e.preventDefault(); addChannel(); } }}
            placeholder={tr('channelAdd')} className="text-sm outline-none bg-transparent"
            style={{ padding: '7px 4px 7px 14px', width: 150, fontSize: 12.5 }} />
          <button onClick={addChannel} disabled={!newChannel.trim()} aria-label="add"
            style={{ color: newChannel.trim() ? NAVY : INK_LIGHT, padding: '7px 10px 7px 4px', lineHeight: 0 }}><Plus size={13} /></button>
        </span>
      </div>
      <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 16 }}>{tr('channelHint')}</div>

      <SectionLabel>{tr('shopLabel')}</SectionLabel>
      <div className="flex flex-wrap gap-2 mb-4">
        {(isStock ? ONLINE_SHOPS : [...ONLINE_SHOPS, LAB_SHOP]).map((s: string) => (
          <button key={s} onClick={() => { setShop(s); if (s === LAB_SHOP) setDeliveryMode('direct'); }}
            style={{
              backgroundColor: shop === s ? NAVY : '#fff', color: shop === s ? '#FBF7F0' : INK,
              border: shop === s ? 'none' : `1px solid ${BORDER}`, fontSize: 12.5, fontWeight: shop === s ? 600 : 500,
              padding: '7px 14px', borderRadius: 999,
            }}>{s}</button>
        ))}
      </div>

      {!isStock && (
        <>
          <SectionLabel>{tr('deliveryModeLabel')}</SectionLabel>
          <div className="grid grid-cols-2 gap-2 mb-1.5">
            {([['shop', tr('dmShop')], ['direct', tr('dmDirect')]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setDeliveryMode(k)} disabled={shop === LAB_SHOP && k === 'shop'}
                style={{
                  backgroundColor: deliveryMode === k ? NAVY : '#fff', color: deliveryMode === k ? '#FBF7F0' : INK,
                  border: deliveryMode === k ? 'none' : `1px solid ${BORDER}`, fontSize: 12.5, fontWeight: deliveryMode === k ? 700 : 500,
                  padding: '9px 8px', borderRadius: 10, opacity: shop === LAB_SHOP && k === 'shop' ? 0.4 : 1,
                }}>{label}</button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: shop === LAB_SHOP ? NAVY : INK_LIGHT, marginBottom: 16, fontWeight: shop === LAB_SHOP ? 600 : 400 }}>
            {shop === LAB_SHOP ? tr('dmLabHint') : deliveryMode === 'direct' ? tr('dmDirectHint') : tr('dmShopHint')}
          </div>
        </>
      )}

      <SectionLabel>{tr('addProduct')}</SectionLabel>
      <div className="relative mb-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <Search size={14} color={INK_LIGHT} />
          <input value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(true); }} placeholder={tr('searchPh')}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); (e.target as HTMLInputElement).blur(); } }}
            className="flex-1 text-sm outline-none" />
          {searching && <Loader2 size={14} className="animate-spin" color={INK_LIGHT} />}
          {!searching && query && (
            <button onMouseDown={e => e.preventDefault()} onClick={() => { setQuery(''); setSearchOpen(false); }} aria-label="clear"><X size={14} color={INK_LIGHT} /></button>
          )}
        </div>
        {searchOpen && query.trim() && results.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg shadow-lg max-h-64 overflow-y-auto" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
            {results.map((p: OnlineProduct) => (
              <button key={`${p.ficheId}:${p.variantId}`} onMouseDown={e => e.preventDefault()} onClick={() => addToCart(p)}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
                {p.imageUrl ? <img src={p.imageUrl} className="w-8 h-8 rounded object-cover" /> : <div className="w-8 h-8 rounded" style={{ backgroundColor: CREAM }} />}
                <span>{p.nameVi}{p.isCake ? ' 🎂' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {cart.length > 0 && (
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          {cart.map((l: CartLine) => (
            <div key={l.key} className="p-3" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
              <div className="flex items-center gap-2.5">
                {l.imageUrl
                  ? <img src={thumb(l.imageUrl, 112)} alt="" loading="lazy" className="w-12 h-12 rounded-lg object-cover shrink-0" style={{ border: `1px solid ${BORDER}` }} />
                  : <div className="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: CREAM }}>{l.isCake ? '🎂' : '🥐'}</div>}
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.nameVi}</div>
                </div>
                <button onClick={() => removeLine(l.key)}><X size={14} color={INK_LIGHT} /></button>
              </div>
              <div className="flex items-center justify-between mt-2" style={{ fontSize: 11, color: INK_LIGHT }}>
                <span>{tr('priceLabel')}</span>
                {l.listPrice != null && <span>{tr('listPrice')}: <b style={{ color: INK }}>{fmtVnd(l.listPrice)}</b></span>}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <div className="flex items-center gap-2">
                  <button onClick={() => updateLine(l.key, { qty: Math.max(1, l.qty - 1) })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Minus size={12} color={NAVY} /></button>
                  <span style={{ fontSize: 13.5, fontWeight: 700, width: 18, textAlign: 'center' }}>{l.qty}</span>
                  <button onClick={() => updateLine(l.key, { qty: l.qty + 1 })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Plus size={12} color={NAVY} /></button>
                </div>
                <input type="number" min={0} value={l.unitPrice} onChange={e => updateLine(l.key, { unitPrice: Number(e.target.value) })}
                  placeholder={tr('unitPrice')} className="flex-1 min-w-0 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                <label className="flex items-center gap-1 shrink-0" style={{ fontSize: 11, color: INK_LIGHT }}>
                  {tr('discPct')}
                  <input type="number" min={0} max={100} inputMode="decimal" value={l.discountPct ?? ''} aria-label={tr('discPct')}
                    onChange={e => { const v = e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))); updateLine(l.key, { discountPct: v }); }}
                    placeholder="0" className="w-12 px-1.5 py-1.5 rounded text-sm text-right" style={{ border: `1px solid ${Number(l.discountPct) > 0 ? '#B45309' : BORDER}` }} />
                </label>
                <div style={{ minWidth: 64, textAlign: 'right' }}>
                  {Number(l.discountPct) > 0 && <div style={{ fontSize: 11, color: INK_LIGHT, textDecoration: 'line-through' }}>{fmtCompactVnd(l.qty * (Number(l.unitPrice) || 0))}</div>}
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: Number(l.discountPct) > 0 ? '#B45309' : undefined }}>{fmtCompactVnd(l.qty * netPrice(Number(l.unitPrice) || 0, Number(l.discountPct) || 0))}</div>
                </div>
              </div>
              <input value={l.lineNote ?? ''} onChange={e => updateLine(l.key, { lineNote: e.target.value })}
                placeholder={tr('lineNote')} maxLength={300}
                className="w-full px-2 py-1.5 rounded text-sm mt-2" style={{ border: `1px solid ${BORDER}` }} />
              {l.isCake && !isStock && (
                <div className="mt-2 space-y-2">
                  <input value={l.message ?? ''} onChange={e => updateLine(l.key, { message: e.target.value })}
                    placeholder={tr('cakeMsg')} maxLength={200}
                    className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                  <textarea value={l.designNotes ?? ''} onChange={e => updateLine(l.key, { designNotes: e.target.value })}
                    placeholder={tr('designNotes')} maxLength={400} rows={2}
                    className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                  <div style={{ fontSize: 11, color: INK_LIGHT }}>{tr('designPhotoHint')}</div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs cursor-pointer" style={{ border: `1px dashed ${BORDER}`, color: INK_LIGHT }}>
                      🖼️ {tr('designPhoto')}
                      <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onDesignPhoto(l.key, f); }} />
                    </label>
                    {l.designPhotoUrl && <img src={thumb(l.designPhotoUrl, 112)} className="w-10 h-10 rounded object-cover" style={{ border: `1px solid ${BORDER}` }} />}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <SectionLabel>{tr('feesLabel')}</SectionLabel>
        <button onClick={() => setManageFeesOpen(true)} className="inline-flex items-center gap-1 rounded-full"
          style={{ color: NAVY, backgroundColor: CREAM, fontSize: 11, fontWeight: 700, padding: '4px 9px 4px 8px', marginBottom: 8 }}>
          <Settings size={11} />{tr('manageFees')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        {feeTypes.map((f: ExtraFeeType) => (
          <button key={f.id} onClick={() => addFeeToCart(f)} className="inline-flex items-center gap-1.5 rounded-full"
            style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', fontSize: 12.5, fontWeight: 600, padding: '7px 12px', color: INK }}>
            {f.emoji ? `${f.emoji} ` : ''}{f.label} <span style={{ color: INK_LIGHT, fontWeight: 500 }}>+{fmtCompactVnd(f.defaultPrice)}</span>
          </button>
        ))}
        <button onClick={() => setManageFeesOpen(true)} className="inline-flex items-center gap-1 rounded-full"
          style={{ border: `1px dashed ${BORDER}`, fontSize: 12.5, fontWeight: 600, padding: '7px 12px 7px 10px', color: INK_LIGHT }}>
          <Plus size={12} />{tr('addFeeType')}
        </button>
      </div>

      {feeCart.length > 0 && (
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          {feeCart.map((l: any) => (
            <div key={l.key} className="p-3" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
              <div className="flex items-center gap-2.5">
                <div className="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: CREAM }}>{l.emoji ?? '🎁'}</div>
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.label}</div>
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#9C7C2C', backgroundColor: CREAM, borderRadius: 5, padding: '2px 6px' }}>{tr('feeBadge')}</span>
                </div>
                <button onClick={() => removeFeeLine(l.key)}><X size={14} color={INK_LIGHT} /></button>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => updateFeeLine(l.key, { qty: Math.max(1, l.qty - 1) })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Minus size={12} color={NAVY} /></button>
                  <span style={{ fontSize: 13.5, fontWeight: 700, width: 18, textAlign: 'center' }}>{l.qty}</span>
                  <button onClick={() => updateFeeLine(l.key, { qty: l.qty + 1 })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Plus size={12} color={NAVY} /></button>
                </div>
                <input type="number" min={0} value={l.unitPrice} onChange={(e: any) => updateFeeLine(l.key, { unitPrice: Number(e.target.value) })}
                  className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 64, textAlign: 'right' }}>{fmtCompactVnd(l.qty * (Number(l.unitPrice) || 0))}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {manageFeesOpen && (
        <div className="fixed inset-0 z-30 flex items-end justify-center" style={{ backgroundColor: 'rgba(26,44,36,0.42)' }} onClick={() => setManageFeesOpen(false)}>
          <div onClick={(e: any) => e.stopPropagation()} className="w-full max-w-xl rounded-t-2xl p-4" style={{ backgroundColor: '#FFFEFB', maxHeight: '82vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between mb-1">
              <span style={{ fontSize: 14.5, fontWeight: 700 }}>⚙ {tr('manageFeesTitle')}</span>
              <button onClick={() => setManageFeesOpen(false)}><X size={16} color={INK_LIGHT} /></button>
            </div>
            <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 12 }}>{tr('manageFeesHint')}</div>
            {feeTypes.map((f: ExtraFeeType) => (
              <div key={f.id} className="flex items-center gap-2 py-2" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
                <span style={{ fontSize: 17, width: 22, textAlign: 'center' }}>{f.emoji ?? '🎁'}</span>
                <input value={f.label} onChange={(e: any) => updateFeeTypeLabel(f.id, e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded text-sm min-w-0" style={{ border: `1px solid ${BORDER}` }} />
                <input type="number" value={f.defaultPrice} onChange={(e: any) => updateFeeTypePrice(f.id, Number(e.target.value) || 0)}
                  className="px-2 py-1.5 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}`, width: 84 }} />
                <button onClick={() => deleteFeeType(f.id)}><X size={14} color={INK_LIGHT} /></button>
              </div>
            ))}
            <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: `1px dashed ${BORDER}` }}>
              <input value={newFeeEmoji} onChange={(e: any) => setNewFeeEmoji(e.target.value)} maxLength={4}
                className="px-2 py-1.5 rounded text-sm text-center" style={{ border: `1px solid ${BORDER}`, width: 44 }} />
              <input value={newFeeLabel} onChange={(e: any) => setNewFeeLabel(e.target.value)} placeholder={tr('newFeeNamePh')}
                className="flex-1 px-2 py-1.5 rounded text-sm min-w-0" style={{ border: `1px solid ${BORDER}` }} />
              <input type="number" value={newFeePrice} onChange={(e: any) => setNewFeePrice(e.target.value)} placeholder={tr('newFeePricePh')}
                className="px-2 py-1.5 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}`, width: 84 }} />
              <button onClick={addFeeType} disabled={!newFeeLabel.trim()}
                style={{ backgroundColor: NAVY, color: '#FBF7F0', fontSize: 12.5, fontWeight: 700, padding: '8px 12px', borderRadius: 8, opacity: newFeeLabel.trim() ? 1 : 0.4 }}>
                + {tr('addBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionLabel>{tr('customerInfo')}</SectionLabel>
      <div className="rounded-xl p-3 mb-4 space-y-2" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <input value={customerName} onChange={(e: any) => setCustomerName(e.target.value)} placeholder={tr('custName')}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <input type="tel" inputMode="numeric" value={customerPhone} onChange={(e: any) => setCustomerPhone(e.target.value)} placeholder={tr('custPhone')}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <input value={deliveryAddress} onChange={(e: any) => setDeliveryAddress(e.target.value)} placeholder={tr('address')}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <select value={district} onChange={(e: any) => setDistrict(e.target.value)}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', color: district ? INK : INK_LIGHT }}>
          <option value="">{tr('districtPlaceholder')}</option>
          {HANOI_DISTRICTS.map((d: string) => <option key={d} value={d}>{d}</option>)}
        </select>
        <div className="flex gap-2">
          <input type="date" value={deliveryDate} onChange={(e: any) => setDeliveryDate(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
          {!isStock && <input type="time" value={readyTime} onChange={(e: any) => setReadyTime(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />}
        </div>
        <textarea value={notes} onChange={(e: any) => setNotes(e.target.value)} placeholder={tr('extraNotes')} rows={2}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
      </div>

      <SectionLabel>{tr('payment')}</SectionLabel>
      <div className="rounded-xl p-3 mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <div className="flex justify-between items-center mb-2">
          <span style={{ fontSize: 13, color: INK_LIGHT }}>{tr('subtotal')}</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtVnd(cartGross)}</span>
        </div>
        {lineDiscountTotal > 0 && (
          <div className="flex justify-between items-center mb-2">
            <span style={{ fontSize: 13, color: '#B45309' }}>{tr('lineDiscRow')}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#B45309' }}>−{fmtVnd(lineDiscountTotal)}</span>
          </div>
        )}
        <div className="flex justify-between items-center gap-2 mb-2">
          <span style={{ fontSize: 13, color: INK_LIGHT }}>{tr('orderDisc')}</span>
          <div className="flex items-center gap-1.5">
            <div className="flex rounded-md overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              {(['pct', 'amount'] as const).map(k => (
                <button key={k} type="button" onClick={() => setOrderDiscKind(k)} aria-pressed={orderDiscKind === k}
                  style={{ fontSize: 12, fontWeight: 700, padding: '5px 9px', backgroundColor: orderDiscKind === k ? NAVY : '#fff', color: orderDiscKind === k ? '#fff' : INK_LIGHT }}>
                  {k === 'pct' ? '%' : '₫'}
                </button>
              ))}
            </div>
            <input type="number" min={0} inputMode="decimal" value={orderDiscValue} onChange={(e: any) => setOrderDiscValue(e.target.value)}
              placeholder="0" aria-label={tr('orderDisc')} className="w-24 px-2 py-1 rounded text-sm text-right" style={{ border: `1px solid ${orderDiscountAmt > 0 ? '#B45309' : BORDER}` }} />
          </div>
        </div>
        {orderDiscountAmt > 0 && (
          <div className="flex justify-end mb-2" style={{ fontSize: 13, fontWeight: 600, color: '#B45309' }}>−{fmtVnd(orderDiscountAmt)}</div>
        )}
        {hasDiscount && (
          <input value={discountReason} onChange={(e: any) => setDiscountReason(e.target.value)} maxLength={120}
            placeholder={tr('discReason')} aria-label={tr('discReason')}
            className="w-full px-2 py-1.5 rounded text-sm mb-2" style={{ border: `1px solid ${discountReason.trim() ? BORDER : '#B45309'}`, backgroundColor: discountReason.trim() ? '#fff' : '#FFFBEB' }} />
        )}
        {feesTotal > 0 && (
          <div className="flex justify-between items-center mb-2">
            <span style={{ fontSize: 13, color: INK_LIGHT }}>{tr('feesRow')}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtVnd(feesTotal)}</span>
          </div>
        )}
        <div className="flex justify-between items-center mb-2">
          <span style={{ fontSize: 13, color: INK_LIGHT }}>{tr('deliveryFee')}</span>
          <input type="number" min={0} value={deliveryFee} onChange={(e: any) => setDeliveryFee(e.target.value)}
            className="w-28 px-2 py-1 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}` }} />
        </div>
        <div className="flex justify-between items-center mb-3">
          <span style={{ fontSize: 14.5, fontWeight: 700 }}>{tr('total')}</span>
          <span style={{ fontSize: 17, fontWeight: 700, color: NAVY }}>{fmtVnd(grandTotal)}</span>
        </div>
        <div className="flex gap-2 mb-2">
          {(['paid', 'unpaid', 'partial'] as const).map(s => (
            <button key={s} onClick={() => setPaymentStatus(s)}
              style={{
                flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 700, padding: '8px 0', borderRadius: 8,
                backgroundColor: paymentStatus === s ? '#047857' : CREAM, color: paymentStatus === s ? '#fff' : INK_LIGHT,
                border: paymentStatus === s ? 'none' : `1px solid ${BORDER}`,
              }}>
              {s === 'paid' ? tr('paid') : s === 'unpaid' ? tr('unpaid') : tr('partial')}
            </button>
          ))}
        </div>
        {paymentStatus === 'partial' && (
          <input type="number" min={0} value={amountPaid} onChange={(e: any) => setAmountPaid(e.target.value)}
            placeholder={tr('depositAmount')} className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        )}
      </div>

      {submitMsg && (
        <div className="rounded-lg p-2.5 mb-3 text-sm" style={{
          backgroundColor: submitMsg.kind === 'ok' ? '#F0FDF4' : submitMsg.kind === 'warn' ? '#FFFBEB' : '#FDECEC',
          color: submitMsg.kind === 'ok' ? '#047857' : submitMsg.kind === 'warn' ? '#b45309' : '#dc2626',
        }}>{submitMsg.text}</div>
      )}

      <button onClick={onSubmit} disabled={submitting || !cart.length}
        style={{ backgroundColor: isStock ? '#B45309' : GOLD, color: isStock ? '#fff' : NAVY, opacity: submitting || !cart.length ? 0.6 : 1 }}
        className="w-full text-center text-[15px] font-bold py-3.5 rounded-xl mb-4">
        {submitting ? (isStock ? tr('savingStock') : tr('creating')) : (isStock ? tr('submitStock') : tr('submit'))}
      </button>
    </div>
  );
}

function StatsTab() {
  const { tr, lang } = useL();
  const [range, setRange] = useState<14 | 30 | 90 | 365>(14);
  // Custom period (Axel, 2026-09-22: "filtrer les stats sur une date donnee ou un mois donnee",
  // then 2026-09-23 after the month-picker input crashed: "tu peux laisser la possibilite du
  // calendrier mais selectionner entre 2 dates" — dropped the separate month/day pickers
  // entirely in favour of a plain from/to date range; a single day is just from === to, and a
  // full month is picking the 1st through the last day by hand). Overrides the rolling `range`
  // presets above once both dates are set; pClear resets back to them.
  const [customFrom, setCustomFrom] = useState<string | null>(null); // 'YYYY-MM-DD'
  const [customTo, setCustomTo] = useState<string | null>(null); // 'YYYY-MM-DD'
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [channelProducts, setChannelProducts] = useState<Record<string, ChannelProductDetail[]>>({});
  const [channelLoading, setChannelLoading] = useState<string | null>(null);
  const [data, setData] = useState<OnlineAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(false);
    setOpenChannel(null); setChannelProducts({}); // stale detail lists would show the wrong period
    const opts = customFrom && customTo && customTo >= customFrom
      ? { from: customFrom, to: customTo }
      : { rangeDays: range };
    actions.getOnlineAnalyticsAction(opts)
      .then(res => { if (!alive) return; if (res.error) { setLoadError(true); setLoading(false); return; } setData(res.data ?? null); setLoading(false); })
      // A thrown/rejected server action must never take the whole page down (Axel, 2026-09-23:
      // the old month-picker input crashed to a blank "Application error" page) — show an inline
      // retry state instead.
      .catch(() => { if (alive) { setLoadError(true); setLoading(false); } });
    return () => { alive = false; };
  }, [range, customFrom, customTo]);
  async function toggleChannel(channel: string) {
    if (openChannel === channel) { setOpenChannel(null); return; }
    setOpenChannel(channel);
    if (!channelProducts[channel] && data) {
      setChannelLoading(channel);
      try {
        const res = await actions.getChannelProductDetailsAction(channel, data.rangeStart, data.rangeEnd);
        setChannelProducts(prev => ({ ...prev, [channel]: res.data ?? [] }));
      } catch {
        setChannelProducts(prev => ({ ...prev, [channel]: [] }));
      } finally {
        setChannelLoading(null);
      }
    }
  }
  if (loadError) {
    return (
      <div className="text-center py-10" style={{ color: INK_LIGHT, fontSize: 13 }}>
        {lang === 'en' ? 'Could not load stats for this period.' : 'Không tải được thống kê cho kỳ này.'}
        <div className="mt-2">
          <button onClick={() => { setCustomFrom(null); setCustomTo(null); setRange(14); }} style={{
            border: `1px solid ${BORDER}`, borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 600, color: INK,
          }}>{lang === 'en' ? 'Reset period' : 'Đặt lại khoảng thời gian'}</button>
        </div>
      </div>
    );
  }
  if (!data) return <div className="text-center py-10" style={{ color: INK_LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const maxShop = Math.max(1, ...data.byShop.map(s => s.total));
  const maxCat = Math.max(1, ...data.byCategory.map(c => c.total));
  const maxChannel = Math.max(1, ...data.byChannel.map(c => c.total));
  const sumShop = data.byShop.reduce((a, s) => a + s.total, 0) || 1;
  const sumCat = data.byCategory.reduce((a, c) => a + c.total, 0) || 1;
  const sumChannel = data.byChannel.reduce((a, c) => a + c.total, 0) || 1;
  const pct = (v: number, sum: number) => `${Math.round((v / sum) * 100)}%`;
  // Bar chart geometry (viewBox 320×110). A sqrt scale (not linear) keeps ordinary days
  // legible even when one outlier day dwarfs the rest — a single 3.3M day used to crush every
  // ~50k day down to an invisible sliver. Hover/tap a bar (or read the callout, defaulted to
  // the peak day) to see its exact date and amount.
  const series = data.series;
  const maxSeries = Math.max(1, ...series.map(d => d.total));
  const CH = { w: 320, h: 116, top: 20, bottom: 22, left: 2, right: 2 };
  const plotH = CH.h - CH.top - CH.bottom;
  const slot = (CH.w - CH.left - CH.right) / Math.max(1, series.length);
  const barW = Math.max(2, slot * 0.62);
  const barH = (v: number) => v <= 0 ? 0 : Math.max(2.5, Math.sqrt(v / maxSeries) * plotH);
  const MAX_LABELS = 6;
  const labelStep = Math.max(1, Math.ceil(series.length / MAX_LABELS));
  const labelIdx = new Set<number>();
  for (let i = 0; i < series.length; i += labelStep) labelIdx.add(i);
  if (series.length > 0) labelIdx.add(series.length - 1);
  const peakIdx = series.length ? series.reduce((best, d, i) => d.total > series[best].total ? i : best, 0) : -1;
  const shownIdx = activeIdx ?? (peakIdx >= 0 && series[peakIdx]?.total > 0 ? peakIdx : null);
  const shownDay = shownIdx !== null ? series[shownIdx] : null;
  const granularity = data.rangeDays <= 30 ? tr('perDay') : data.rangeDays <= 90 ? tr('perWeek') : tr('perMonth');
  const SHOP_HUES = [NAVY, '#572C1A', '#5C9179', '#8CB4A2', '#BBD4C7'];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5 mb-4">
        <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, marginBottom: 4 }}>{tr('today')}</div>
          <div style={{ fontSize: 9.5, color: INK_LIGHT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>{tr('merchLabel')}</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(data.todayTotal)}</div>
          <div style={{ fontSize: 9.5, color: INK_LIGHT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 3 }}>{tr('grandLabel')}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{fmtCompactVnd(data.todayGrandTotal)}</div>
          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600, marginTop: 2 }}>{data.todayCount} {tr('orders')}</div>
        </div>
        <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, marginBottom: 4 }}>{tr('thisMonth')}</div>
          <div style={{ fontSize: 9.5, color: INK_LIGHT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>{tr('merchLabel')}</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(data.monthTotal)}</div>
          <div style={{ fontSize: 9.5, color: INK_LIGHT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 3 }}>{tr('grandLabel')}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{fmtCompactVnd(data.monthGrandTotal)}</div>
          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600, marginTop: 2 }}>{data.monthCount} {tr('orders')}</div>
        </div>
      </div>

      <SectionLabel>{tr('period')}</SectionLabel>
      <div className="flex gap-2 mb-2 overflow-x-auto">
        {([[14, tr('p14')], [30, tr('p30')], [90, tr('p90')], [365, tr('p365')]] as const).map(([d, label]) => (
          <button key={d} onClick={() => { setRange(d); setCustomFrom(null); setCustomTo(null); }} style={{
            backgroundColor: !customFrom && !customTo && range === d ? NAVY : '#fff', color: !customFrom && !customTo && range === d ? '#FBF7F0' : INK,
            border: !customFrom && !customTo && range === d ? 'none' : `1px solid ${BORDER}`, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
        {loading && <Loader2 size={14} className="animate-spin self-center" color={INK_LIGHT} />}
      </div>
      {/* Custom period (Axel, 2026-09-22, then simplified 2026-09-23 after the month-picker
          input crashed the page: "laisser la possibilite du calendrier mais selectionner entre 2
          dates") — a plain from/to date range instead of separate month/day pickers. Both inputs
          override the presets above once filled; the ✕ clears back to them. A single day is
          just picking the same date twice. */}
      <div className="flex gap-2 mb-3 items-center overflow-x-auto">
        <label className="flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{
          border: customFrom ? `1px solid ${NAVY}` : `1px solid ${BORDER}`, backgroundColor: '#fff',
        }}>
          <span style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, whiteSpace: 'nowrap' }}>{tr('pFrom')}</span>
          <input type="date" value={customFrom ?? ''} onChange={(e: any) => setCustomFrom(e.target.value || null)}
            style={{ fontSize: 12, border: 'none', outline: 'none', color: INK, backgroundColor: 'transparent', width: 128 }} />
        </label>
        <label className="flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{
          border: customTo ? `1px solid ${NAVY}` : `1px solid ${BORDER}`, backgroundColor: '#fff',
        }}>
          <span style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, whiteSpace: 'nowrap' }}>{tr('pTo')}</span>
          <input type="date" value={customTo ?? ''} onChange={(e: any) => setCustomTo(e.target.value || null)}
            style={{ fontSize: 12, border: 'none', outline: 'none', color: INK, backgroundColor: 'transparent', width: 128 }} />
        </label>
        {(customFrom || customTo) && (
          <button onClick={() => { setCustomFrom(null); setCustomTo(null); }} aria-label={tr('pClear')}
            style={{ color: INK_LIGHT, padding: '6px 8px', lineHeight: 0 }}><X size={13} /></button>
        )}
      </div>

      <div className="rounded-xl p-3.5 mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', opacity: loading ? 0.6 : 1 }}>
        <div className="flex justify-between items-baseline mb-1">
          <SectionLabel>{tr('revenueTrend')} · {granularity}</SectionLabel>
          <div style={{ fontSize: 11, color: INK_LIGHT }}>{tr('rangeTotal')}: <b style={{ color: NAVY }}>{fmtVnd(data.rangeTotal)}</b> ({tr('rangeGrandTotal')} <b style={{ color: INK }}>{fmtVnd(data.rangeGrandTotal)}</b>) · {data.rangeCount} {tr('orders')}</div>
        </div>
        <div style={{ fontSize: 11.5, color: shownDay ? NAVY : INK_LIGHT, fontWeight: 700, marginBottom: 3, minHeight: 15 }}>
          {shownDay ? `${shownDay.label} — ${fmtVnd(shownDay.total)}` : ' '}
        </div>
        <svg viewBox={`0 0 ${CH.w} ${CH.h}`} width="100%" height={CH.h} role="img" aria-label={tr('trendAria')}
          onMouseLeave={() => setActiveIdx(null)}>
          <line x1={CH.left} x2={CH.w - CH.right} y1={CH.top + plotH} y2={CH.top + plotH} stroke={BORDER} />
          {series.map((d, i) => {
            const h = barH(d.total);
            const x = CH.left + i * slot + (slot - barW) / 2;
            const isShown = shownIdx === i;
            return (
              <g key={d.key}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => setActiveIdx(cur => cur === i ? null : i)}
                style={{ cursor: 'pointer' }}>
                {/* Wider invisible hit-area so short/zero bars are still easy to hover/tap. */}
                <rect x={CH.left + i * slot} y={CH.top} width={slot} height={plotH} fill="transparent" />
                <rect x={x} y={CH.top + plotH - h} width={barW} height={h} rx={1.5}
                  fill={d.total > 0 ? (isShown ? NAVY : GOLD) : CREAM_DARK} />
                {labelIdx.has(i) && (
                  <text x={x + barW / 2} y={CH.h - 8} fontSize={8.5}
                    fill={isShown ? NAVY : INK_LIGHT} fontWeight={isShown ? 700 : 400}
                    textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>{d.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <SectionLabel>{tr('byShop')}</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byShop.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>{tr('noData')}</div>}
        {data.byShop.map((s, i) => (
          <div key={s.shop}>
            <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{s.shop}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtVnd(s.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11.5 }}>· {pct(s.total, sumShop)}</span></span>
            </div>
            <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(0, (s.total / maxShop) * 100)}%`, height: '100%', backgroundColor: SHOP_HUES[i % SHOP_HUES.length], borderRadius: 5 }} />
            </div>
          </div>
        ))}
      </div>

      <SectionLabel>{tr('byCat')}</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byCategory.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>{tr('noData')}</div>}
        {data.byCategory.map((c, i) => {
          const open = openCat === c.category;
          return (
          <div key={c.category}>
            <button onClick={() => setOpenCat(open ? null : c.category)} className="w-full text-left">
              <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
                <span style={{ fontWeight: 600 }}>{open ? '▾' : '▸'} {c.category} <span style={{ color: INK_LIGHT, fontWeight: 500, fontSize: 11 }}>({c.products.length})</span></span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtCompactVnd(c.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11.5 }}>· {pct(c.total, sumCat)}</span></span>
              </div>
              <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(0, (c.total / maxCat) * 100)}%`, height: '100%', backgroundColor: SHOP_HUES[i % SHOP_HUES.length], borderRadius: 5 }} />
              </div>
            </button>
            {open && (
              <div className="mt-2 mb-1 rounded-lg" style={{ backgroundColor: '#FFFDF5', border: `1px solid ${CREAM_DARK}` }}>
                {c.products.map((p, j) => (
                  <div key={`${p.sku ?? p.name}-${j}`} className="flex justify-between items-center px-2.5 py-1.5" style={{ fontSize: 12, borderTop: j ? `1px solid ${CREAM_DARK}` : 'none' }}>
                    <span className="min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', paddingRight: 8 }}>{p.name}{p.sku ? <span style={{ color: INK_LIGHT, fontSize: 10.5 }}> · {p.sku}</span> : null}</span>
                    <span className="shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>×{p.qty} · <b>{fmtCompactVnd(p.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11 }}>· {pct(p.total, c.total || 1)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>

      <SectionLabel>{tr('byChannel')}</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byChannel.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>{tr('noData')}</div>}
        {data.byChannel.map((c, i) => {
          const open = openChannel === c.channel;
          const products = channelProducts[c.channel];
          const channelSum = (products ?? []).reduce((a, p) => a + p.total, 0) || 1;
          return (
          <div key={c.channel}>
            <button onClick={() => toggleChannel(c.channel)} className="w-full text-left">
              <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
                <span style={{ fontWeight: 600 }}>{open ? '▾' : '▸'} {c.channel}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtCompactVnd(c.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11.5 }}>· {pct(c.total, sumChannel)}</span></span>
              </div>
              <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(0, (c.total / maxChannel) * 100)}%`, height: '100%', backgroundColor: GOLD, borderRadius: 5 }} />
              </div>
            </button>
            {open && (
              <div className="mt-2 mb-1 rounded-lg" style={{ backgroundColor: '#FFFDF5', border: `1px solid ${CREAM_DARK}` }}>
                {channelLoading === c.channel ? (
                  <div className="flex items-center gap-1.5 px-2.5 py-2" style={{ fontSize: 12, color: INK_LIGHT }}>
                    <Loader2 size={12} className="animate-spin" /> {tr('channelOrdersLoading')}
                  </div>
                ) : !products || products.length === 0 ? (
                  <div className="px-2.5 py-2" style={{ fontSize: 12, color: INK_LIGHT }}>{tr('channelOrdersEmpty')}</div>
                ) : products.map((p, j) => (
                  <div key={`${p.sku ?? p.name}-${j}`} className="flex justify-between items-center px-2.5 py-1.5" style={{ fontSize: 12, borderTop: j ? `1px solid ${CREAM_DARK}` : 'none' }}>
                    <span className="min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', paddingRight: 8 }}>{p.name}{p.sku ? <span style={{ color: INK_LIGHT, fontSize: 10.5 }}> · {p.sku}</span> : null}</span>
                    <span className="shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>×{p.qty} · <b>{fmtCompactVnd(p.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11 }}>· {pct(p.total, channelSum)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
