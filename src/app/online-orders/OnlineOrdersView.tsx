'use client';
import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Minus, X, Loader2, Bell } from 'lucide-react';
import { SHOP_NAMES_ALL } from '@/lib/shops';
import { pushSupport, getExistingPushSubscription, requestPushSubscription, unsubscribeCurrentPush } from '@/lib/push-client';
import * as actions from './actions';
import type { OnlineProduct, OnlineOrderItem, OnlineOrderSummary, OnlineAnalytics } from './actions';

const NAVY = '#1A4731';
const GOLD = '#C9A84C';
const CREAM = '#FFF4CC';
const CREAM_DARK = '#F5E89A';
const INK = '#1A2C24';
const INK_LIGHT = '#6B7280';
const BORDER = '#E0D49A';
const TABBAR = '#163D29';

const CHANNEL_SUGGESTIONS = ['Hoàn Kiếm', 'Moon Flower', 'Website', 'Page Merci'];

function fmtVnd(v: number): string {
  return `${Math.round(v).toLocaleString('vi-VN')} ₫`;
}
function fmtCompactVnd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M ₫`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k ₫`;
  return `${Math.round(v)} ₫`;
}

type CartLine = OnlineOrderItem & { key: string; nameVi: string; imageUrl: string | null; isCake: boolean };
type Tab = 'order' | 'track' | 'stats';

export default function OnlineOrdersView({ fullName, isAdmin }: { fullName: string; isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>('order');
  const today = new Date().toISOString().slice(0, 10);
  const dateLabel = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

  // ── Order form state ──
  const [shop, setShop] = useState(SHOP_NAMES_ALL[0]);
  const [channel, setChannel] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(today);
  const [readyTime, setReadyTime] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('0');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid' | 'partial'>('unpaid');
  const [amountPaid, setAmountPaid] = useState('0');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  useEffect(() => {
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
        key, ficheId: p.ficheId, variantId: p.variantId, qty: 1, unitPrice: 0,
        message: null, designNotes: null, designPhotoUrl: null,
        nameVi: p.nameVi, imageUrl: p.imageUrl, isCake: p.isCake,
      }];
    });
    setQuery(''); setResults([]);
  }
  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function removeLine(key: string) {
    setCart(prev => prev.filter(l => l.key !== key));
  }
  async function onDesignPhoto(key: string, file: File) {
    const fd = new FormData(); fd.append('file', file);
    const res = await actions.uploadOnlineDesignPhotoAction(fd);
    if (res.url) updateLine(key, { designPhotoUrl: res.url });
  }

  const cartTotal = useMemo(() => cart.reduce((s, l) => s + l.qty * (Number(l.unitPrice) || 0), 0), [cart]);
  const grandTotal = cartTotal + (Number(deliveryFee) || 0);

  async function handleSubmit() {
    if (!channel.trim()) { setSubmitMsg({ kind: 'error', text: 'Chọn hoặc nhập kênh bán hàng' }); return; }
    if (!cart.length) { setSubmitMsg({ kind: 'error', text: 'Giỏ hàng trống' }); return; }
    setSubmitting(true); setSubmitMsg(null);
    const res = await actions.submitOnlineOrderAction({
      shop, channel: channel.trim(), deliveryDate, readyTime: readyTime || null,
      customerName: customerName || null, customerPhone: customerPhone || null,
      deliveryAddress: deliveryAddress || null, notes: notes || null,
      deliveryFee: Number(deliveryFee) || 0, paymentStatus, amountPaid: Number(amountPaid) || 0,
      items: cart.map(({ key, nameVi, imageUrl, isCake, ...rest }) => rest),
    });
    setSubmitting(false);
    if (res.error) { setSubmitMsg({ kind: 'error', text: res.error }); return; }
    if (res.warning) { setSubmitMsg({ kind: 'warn', text: res.warning }); }
    else setSubmitMsg({ kind: 'ok', text: res.orderRef ? `Đã tạo đơn Odoo: ${res.orderRef}` : 'Đã lưu đơn hàng' });
    setCart([]); setChannel(''); setCustomerName(''); setCustomerPhone(''); setDeliveryAddress(''); setNotes('');
    setDeliveryFee('0'); setPaymentStatus('unpaid'); setAmountPaid('0');
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: CREAM }}>
      <Header fullName={fullName} count={cart.length} tab={tab} />
      <div className="flex-1 overflow-y-auto pb-20">
        <div className="max-w-xl mx-auto px-4 py-4">
          {tab === 'order' && (
            <OrderTab
              shop={shop} setShop={setShop} channel={channel} setChannel={setChannel}
              deliveryDate={deliveryDate} setDeliveryDate={setDeliveryDate}
              readyTime={readyTime} setReadyTime={setReadyTime}
              customerName={customerName} setCustomerName={setCustomerName}
              customerPhone={customerPhone} setCustomerPhone={setCustomerPhone}
              deliveryAddress={deliveryAddress} setDeliveryAddress={setDeliveryAddress}
              notes={notes} setNotes={setNotes}
              deliveryFee={deliveryFee} setDeliveryFee={setDeliveryFee}
              paymentStatus={paymentStatus} setPaymentStatus={setPaymentStatus}
              amountPaid={amountPaid} setAmountPaid={setAmountPaid}
              cart={cart} updateLine={updateLine} removeLine={removeLine} onDesignPhoto={onDesignPhoto}
              query={query} setQuery={setQuery} results={results} searching={searching} addToCart={addToCart}
              cartTotal={cartTotal} grandTotal={grandTotal}
              submitting={submitting} submitMsg={submitMsg} onSubmit={handleSubmit}
            />
          )}
          {tab === 'track' && <TrackTab isAdmin={isAdmin} />}
          {tab === 'stats' && <StatsTab />}
        </div>
      </div>
      <TabBar tab={tab} setTab={setTab} />
    </div>
  );
}

function Header({ fullName, count, tab }: { fullName: string; count: number; tab: Tab }) {
  const dateLabel = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const [bellState, setBellState] = useState<'off' | 'on' | 'busy'>('off');
  useEffect(() => {
    getExistingPushSubscription().then(sub => setBellState(sub ? 'on' : 'off'));
  }, []);
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
  const titles: Record<Tab, string> = { order: 'Đơn hàng Online', track: 'Theo dõi đơn hàng', stats: 'Thống kê doanh thu' };
  return (
    <div style={{ backgroundColor: NAVY, color: '#FFFAEE' }} className="px-4 pt-3.5 pb-3 sticky top-0 z-10">
      <div className="flex items-center gap-2.5">
        <div style={{ width: 34, height: 34, borderRadius: '50%', backgroundColor: GOLD }} className="flex items-center justify-center text-base flex-shrink-0">🛍️</div>
        <div className="flex-1 min-w-0">
          <div style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 16, lineHeight: 1.15 }}>{titles[tab]}</div>
          <div style={{ fontSize: 11, color: '#F0D98A', marginTop: 1 }}>{dateLabel}{fullName ? ` · ${fullName}` : ''}</div>
        </div>
        {tab === 'order' && count > 0 && (
          <div style={{ backgroundColor: GOLD, color: NAVY, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999 }}>{count} SP</div>
        )}
        {pushSupport() !== 'unsupported' && (
          <button onClick={toggleBell} style={{ color: bellState === 'on' ? GOLD : 'rgba(255,255,255,0.5)' }} aria-label="Thông báo">
            {bellState === 'busy' ? <Loader2 size={18} className="animate-spin" /> : <Bell size={18} fill={bellState === 'on' ? GOLD : 'none'} />}
          </button>
        )}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { key: Tab; icon: string; label: string }[] = [
    { key: 'order', icon: '🧾', label: 'Đặt hàng' },
    { key: 'track', icon: '📦', label: 'Theo dõi' },
    { key: 'stats', icon: '📊', label: 'Thống kê' },
  ];
  return (
    <div style={{ backgroundColor: TABBAR }} className="flex fixed bottom-0 left-0 right-0 z-10">
      {items.map(it => (
        <button key={it.key} onClick={() => setTab(it.key)} className="flex-1 text-center py-2.5"
          style={{ color: tab === it.key ? GOLD : '#8FAE9E', fontWeight: tab === it.key ? 700 : 500, fontSize: 11.5, borderTop: `2px solid ${tab === it.key ? GOLD : 'transparent'}` }}>
          <div>{it.icon}</div>{it.label}
        </button>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{children}</div>;
}

function OrderTab(props: any) {
  const {
    shop, setShop, channel, setChannel, deliveryDate, setDeliveryDate, readyTime, setReadyTime,
    customerName, setCustomerName, customerPhone, setCustomerPhone, deliveryAddress, setDeliveryAddress,
    notes, setNotes, deliveryFee, setDeliveryFee, paymentStatus, setPaymentStatus, amountPaid, setAmountPaid,
    cart, updateLine, removeLine, onDesignPhoto, query, setQuery, results, searching, addToCart,
    cartTotal, grandTotal, submitting, submitMsg, onSubmit,
  } = props;

  return (
    <div>
      <SectionLabel>Kênh bán hàng</SectionLabel>
      <input list="channel-suggestions" value={channel} onChange={e => setChannel(e.target.value)}
        placeholder="Hoàn Kiếm, Website, Page Merci..."
        className="w-full mb-1 px-3 py-2 rounded-lg text-sm" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }} />
      <datalist id="channel-suggestions">{CHANNEL_SUGGESTIONS.map((c: string) => <option key={c} value={c} />)}</datalist>
      <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 16 }}>Nguồn khách hàng — dùng để thống kê, không quyết định shop xử lý đơn.</div>

      <SectionLabel>Shop xử lý đơn (tạo trên Odoo)</SectionLabel>
      <div className="flex flex-wrap gap-2 mb-4">
        {SHOP_NAMES_ALL.map((s: string) => (
          <button key={s} onClick={() => setShop(s)}
            style={{
              backgroundColor: shop === s ? NAVY : '#fff', color: shop === s ? '#FFFAEE' : INK,
              border: shop === s ? 'none' : `1px solid ${BORDER}`, fontSize: 12.5, fontWeight: shop === s ? 600 : 500,
              padding: '7px 14px', borderRadius: 999,
            }}>{s}</button>
        ))}
      </div>

      <SectionLabel>Thêm sản phẩm</SectionLabel>
      <div className="relative mb-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <Search size={14} color={INK_LIGHT} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm sản phẩm theo tên..."
            className="flex-1 text-sm outline-none" />
          {searching && <Loader2 size={14} className="animate-spin" color={INK_LIGHT} />}
        </div>
        {results.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg shadow-lg max-h-64 overflow-y-auto" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
            {results.map((p: OnlineProduct) => (
              <button key={`${p.ficheId}:${p.variantId}`} onClick={() => addToCart(p)}
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
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.nameVi}</div>
                </div>
                <button onClick={() => removeLine(l.key)}><X size={14} color={INK_LIGHT} /></button>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => updateLine(l.key, { qty: Math.max(1, l.qty - 1) })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Minus size={12} color={NAVY} /></button>
                  <span style={{ fontSize: 13.5, fontWeight: 700, width: 18, textAlign: 'center' }}>{l.qty}</span>
                  <button onClick={() => updateLine(l.key, { qty: l.qty + 1 })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Plus size={12} color={NAVY} /></button>
                </div>
                <input type="number" min={0} value={l.unitPrice} onChange={e => updateLine(l.key, { unitPrice: Number(e.target.value) })}
                  placeholder="Đơn giá (₫)" className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 64, textAlign: 'right' }}>{fmtCompactVnd(l.qty * (Number(l.unitPrice) || 0))}</div>
              </div>
              {l.isCake && (
                <div className="mt-2 space-y-2">
                  <input value={l.message ?? ''} onChange={e => updateLine(l.key, { message: e.target.value })}
                    placeholder="Lời nhắn trên bánh (ví dụ: Happy Birthday Linh)" maxLength={200}
                    className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                  <textarea value={l.designNotes ?? ''} onChange={e => updateLine(l.key, { designNotes: e.target.value })}
                    placeholder="Ghi chú thiết kế bánh..." maxLength={400} rows={2}
                    className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs cursor-pointer" style={{ border: `1px dashed ${BORDER}`, color: INK_LIGHT }}>
                      🖼️ Ảnh thiết kế mẫu
                      <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onDesignPhoto(l.key, f); }} />
                    </label>
                    {l.designPhotoUrl && <img src={l.designPhotoUrl} className="w-8 h-8 rounded object-cover" />}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <SectionLabel>Thông tin khách hàng</SectionLabel>
      <div className="rounded-xl p-3 mb-4 space-y-2" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <input value={customerName} onChange={(e: any) => setCustomerName(e.target.value)} placeholder="Tên khách hàng"
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <input value={customerPhone} onChange={(e: any) => setCustomerPhone(e.target.value)} placeholder="Số điện thoại"
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <input value={deliveryAddress} onChange={(e: any) => setDeliveryAddress(e.target.value)} placeholder="Địa chỉ giao hàng"
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <div className="flex gap-2">
          <input type="date" value={deliveryDate} onChange={(e: any) => setDeliveryDate(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
          <input type="time" value={readyTime} onChange={(e: any) => setReadyTime(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        </div>
        <textarea value={notes} onChange={(e: any) => setNotes(e.target.value)} placeholder="Ghi chú thêm..." rows={2}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
      </div>

      <SectionLabel>Thanh toán</SectionLabel>
      <div className="rounded-xl p-3 mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <div className="flex justify-between items-center mb-2">
          <span style={{ fontSize: 13, color: INK_LIGHT }}>Phí giao hàng</span>
          <input type="number" min={0} value={deliveryFee} onChange={(e: any) => setDeliveryFee(e.target.value)}
            className="w-28 px-2 py-1 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}` }} />
        </div>
        <div className="flex justify-between items-center mb-3">
          <span style={{ fontSize: 14.5, fontWeight: 700 }}>Tổng cộng</span>
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
              {s === 'paid' ? '✓ Đã TT' : s === 'unpaid' ? 'Chưa TT' : 'Cọc 1 phần'}
            </button>
          ))}
        </div>
        {paymentStatus === 'partial' && (
          <input type="number" min={0} value={amountPaid} onChange={(e: any) => setAmountPaid(e.target.value)}
            placeholder="Số tiền đã cọc (₫)" className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        )}
      </div>

      {submitMsg && (
        <div className="rounded-lg p-2.5 mb-3 text-sm" style={{
          backgroundColor: submitMsg.kind === 'ok' ? '#F0FDF4' : submitMsg.kind === 'warn' ? '#FFFBEB' : '#FDECEC',
          color: submitMsg.kind === 'ok' ? '#047857' : submitMsg.kind === 'warn' ? '#b45309' : '#dc2626',
        }}>{submitMsg.text}</div>
      )}

      <button onClick={onSubmit} disabled={submitting || !cart.length}
        style={{ backgroundColor: GOLD, color: NAVY, opacity: submitting || !cart.length ? 0.6 : 1 }}
        className="w-full text-center text-[15px] font-bold py-3.5 rounded-xl mb-4">
        {submitting ? 'Đang tạo đơn...' : 'Tạo đơn & gửi Odoo'}
      </button>
    </div>
  );
}

function TrackTab({ isAdmin }: { isAdmin: boolean }) {
  const [orders, setOrders] = useState<OnlineOrderSummary[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'undelivered' | 'unpaid' | 'late'>('all');

  async function load() {
    const res = await actions.getMyOnlineOrdersAction();
    setOrders(res.orders ?? []);
  }
  useEffect(() => { load(); }, []);

  if (!orders) return <div className="text-center py-10" style={{ color: INK_LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const isLate = (o: OnlineOrderSummary) => o.paymentStatus !== 'paid' && (o.labDelivered || o.shopDelivered) && Date.now() - new Date(o.createdAt).getTime() > 24 * 3600 * 1000;
  const filtered = orders.filter(o => {
    if (filter === 'undelivered') return !o.labDelivered || !o.shopDelivered;
    if (filter === 'unpaid') return o.paymentStatus !== 'paid';
    if (filter === 'late') return isLate(o);
    return true;
  });

  async function toggleShopDelivered(o: OnlineOrderSummary) {
    await actions.setShopDeliveredAction(o.orderBatchId, !o.shopDelivered);
    load();
  }
  async function cyclePayment(o: OnlineOrderSummary) {
    const next = o.paymentStatus === 'unpaid' ? 'partial' : o.paymentStatus === 'partial' ? 'paid' : 'unpaid';
    await actions.setPaymentStatusAction(o.orderBatchId, next, next === 'paid' ? o.total + o.deliveryFee : o.amountPaid);
    load();
  }

  return (
    <div>
      <div className="flex gap-2 mb-3 overflow-x-auto">
        {([['all', 'Tất cả'], ['undelivered', 'Chưa giao'], ['unpaid', 'Chưa TT'], ['late', '⚠ Trễ hạn']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            backgroundColor: filter === k ? NAVY : '#fff', color: filter === k ? '#FFFAEE' : INK,
            border: filter === k ? 'none' : `1px solid ${BORDER}`, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>
      {filtered.length === 0 && <div className="text-center py-10 text-sm" style={{ color: INK_LIGHT }}>Chưa có đơn hàng nào.</div>}
      <div className="space-y-2.5">
        {filtered.map(o => {
          const late = isLate(o);
          return (
            <div key={o.orderBatchId} className="rounded-xl p-3" style={{ border: `1px solid ${late ? '#f3b8b8' : BORDER}`, backgroundColor: '#fff' }}>
              <div className="flex justify-between items-start mb-2">
                <div className="flex gap-1.5 items-center flex-wrap">
                  <span style={{ backgroundColor: NAVY, color: '#FFFAEE', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{o.shopName}</span>
                  {o.orderRef ? (
                    <span style={{ backgroundColor: CREAM, color: '#8a7326', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{o.orderRef}</span>
                  ) : (
                    <span style={{ backgroundColor: '#FDECEC', color: '#dc2626', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>Chưa có Odoo</span>
                  )}
                  {o.channel && <span style={{ color: INK_LIGHT, fontSize: 10.5 }}>{o.channel}</span>}
                </div>
                {late && <span style={{ backgroundColor: '#FDECEC', color: '#dc2626', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>⚠ Trễ thanh toán</span>}
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{o.customerName || 'Khách lẻ'}{o.customerPhone ? ` · ${o.customerPhone}` : ''}</div>
              <div style={{ fontSize: 12, color: INK_LIGHT, marginBottom: 9 }}>{o.items.map(i => `${i.nameVi} ×${i.qty}`).join(', ')}</div>
              <div className="flex justify-between items-center mb-2">
                <span style={{ fontSize: 15, fontWeight: 700, color: NAVY }}>{fmtVnd(o.total + o.deliveryFee)}</span>
                <button onClick={() => cyclePayment(o)} style={{
                  backgroundColor: o.paymentStatus === 'paid' ? '#F0FDF4' : CREAM, border: o.paymentStatus === 'paid' ? 'none' : `1px solid ${BORDER}`,
                  color: o.paymentStatus === 'paid' ? '#047857' : '#b45309', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
                }}>
                  {o.paymentStatus === 'paid' ? '✓ Đã thanh toán' : o.paymentStatus === 'partial' ? 'Cọc 1 phần' : 'Chưa thanh toán'}
                </button>
              </div>
              <div style={{ height: 1, backgroundColor: CREAM_DARK, marginBottom: 9 }} />
              <div className="flex gap-2">
                <div className="flex-1 text-center py-1.5 rounded-lg" style={{
                  backgroundColor: o.labDelivered ? '#F0FDF4' : CREAM, color: o.labDelivered ? '#047857' : INK_LIGHT,
                  border: o.labDelivered ? 'none' : `1px solid ${BORDER}`, fontSize: 11.5, fontWeight: o.labDelivered ? 700 : 600,
                }}>{o.labDelivered ? '✓ Lab đã giao' : 'Lab chưa giao'}</div>
                <button onClick={() => toggleShopDelivered(o)} className="flex-1 text-center py-1.5 rounded-lg" style={{
                  backgroundColor: o.shopDelivered ? '#F0FDF4' : CREAM, color: o.shopDelivered ? '#047857' : INK_LIGHT,
                  border: o.shopDelivered ? 'none' : `1px solid ${BORDER}`, fontSize: 11.5, fontWeight: o.shopDelivered ? 700 : 600,
                }}>{o.shopDelivered ? '✓ Shop đã giao' : 'Shop chưa giao'}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatsTab() {
  const [data, setData] = useState<OnlineAnalytics | null>(null);
  useEffect(() => { actions.getOnlineAnalyticsAction().then(res => setData(res.data ?? null)); }, []);
  if (!data) return <div className="text-center py-10" style={{ color: INK_LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const maxDaily = Math.max(1, ...data.daily.map(d => d.total));
  const points = data.daily.map((d, i) => `${(i / 13) * 320},${68 - (d.total / maxDaily) * 60}`).join(' ');
  const maxShop = Math.max(1, ...data.byShop.map(s => s.total));
  const maxCat = Math.max(1, ...data.byCategory.map(c => c.total));
  const SHOP_HUES = [NAVY, '#2D6A4F', '#5C9179', '#8CB4A2', '#BBD4C7'];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5 mb-4">
        <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, marginBottom: 4 }}>Hôm nay</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(data.todayTotal)}</div>
          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600, marginTop: 2 }}>{data.todayCount} đơn</div>
        </div>
        <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, marginBottom: 4 }}>Tháng này</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(data.monthTotal)}</div>
          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600, marginTop: 2 }}>{data.monthCount} đơn</div>
        </div>
      </div>

      <div className="rounded-xl p-3.5 mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <SectionLabel>Doanh thu 14 ngày qua</SectionLabel>
        <svg viewBox="0 0 320 70" width="100%" height={70} role="img" aria-label="Xu hướng doanh thu 14 ngày">
          <polyline points={points} fill="none" stroke={GOLD} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <SectionLabel>CA theo shop</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byShop.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>Chưa có dữ liệu.</div>}
        {data.byShop.map((s, i) => (
          <div key={s.shop}>
            <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{s.shop}</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCompactVnd(s.total)}</span>
            </div>
            <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${(s.total / maxShop) * 100}%`, height: '100%', backgroundColor: SHOP_HUES[i % SHOP_HUES.length], borderRadius: 5 }} />
            </div>
          </div>
        ))}
      </div>

      <SectionLabel>CA theo danh mục sản phẩm</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byCategory.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>Chưa có dữ liệu.</div>}
        {data.byCategory.map((c, i) => (
          <div key={c.category}>
            <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{c.category}</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCompactVnd(c.total)}</span>
            </div>
            <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${(c.total / maxCat) * 100}%`, height: '100%', backgroundColor: SHOP_HUES[i % SHOP_HUES.length], borderRadius: 5 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
