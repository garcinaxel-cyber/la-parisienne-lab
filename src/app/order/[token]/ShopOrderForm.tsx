'use client';
import { useEffect, useState } from 'react';
import { Search, Plus, Minus, X, CheckCircle2, Send } from 'lucide-react';
import { searchShopProductsAction, submitShopOrderAction, type ShopProduct } from './actions';

const SHOPS = ['La Parisienne', 'Moon Flower', 'Paris'];
const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];

type CartItem = { key: string; product: ShopProduct; qty: number; qtyInput: string; message: string };

// Mobile-first public order form for the shops. VI primary, EN hint — no login.
// Several products per submission: shared info entered once, one manual order per line.
export default function ShopOrderForm({ token, today }: { token: string; today: string }) {
  const [shop, setShop] = useState<string>('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShopProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<CartItem[]>([]);
  const [date, setDate] = useState(today);
  const [readyTime, setReadyTime] = useState('');
  const [deliveredBy, setDeliveredBy] = useState('');
  const [address, setAddress] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [sentCount, setSentCount] = useState(0);

  // Picking a shop pre-selects it as the delivery destination (most common case)
  useEffect(() => { if (shop && !deliveredBy) setDeliveredBy(shop); }, [shop]);

  // Debounced product search
  useEffect(() => {
    if (query.trim().length < 1) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await searchShopProductsAction(token, query);
      setResults(res.products ?? []);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query, token]);

  function addProduct(p: ShopProduct) {
    if (!p.hasTeam) { setErr('Sản phẩm chưa sẵn sàng — liên hệ Lab / Product not ready — contact the lab'); return; }
    setErr(null);
    const key = p.variantId ?? p.ficheId;
    setItems(prev => {
      const found = prev.find(i => i.key === key);
      if (found) return prev.map(i => i.key === key ? { ...i, qty: Math.min(500, i.qty + 1), qtyInput: String(Math.min(500, i.qty + 1)) } : i);
      return [...prev, { key, product: p, qty: 1, qtyInput: '1', message: '' }];
    });
    setQuery(''); setResults([]);
  }
  const setItemQty = (key: string, qty: number, qtyInput: string) =>
    setItems(prev => prev.map(i => i.key === key ? { ...i, qty, qtyInput } : i));
  const removeItem = (key: string) => setItems(prev => prev.filter(i => i.key !== key));

  function resetAll() {
    setQuery(''); setResults([]); setItems([]);
    setDate(today); setReadyTime(''); setAddress(''); setCustomerName(''); setCustomerPhone(''); setNotes('');
    setErr(null); setDone(false);
  }

  async function submit() {
    setErr(null);
    if (!shop) { setErr('Chọn shop của bạn / Choose your shop'); return; }
    if (items.length === 0) { setErr('Chọn ít nhất 1 sản phẩm / Add at least one product'); return; }
    setSending(true);
    const res = await submitShopOrderAction(token, {
      shop, deliveryDate: date, readyTime: readyTime || null,
      deliveredBy: deliveredBy || null, deliveryAddress: address || null,
      customerName: customerName || null, customerPhone: customerPhone || null,
      notes: notes || null,
      items: items.map(i => ({
        ficheId: i.product.ficheId, variantId: i.product.variantId,
        qty: i.qty, message: i.product.isCake ? (i.message || null) : null,
      })),
    });
    setSending(false);
    if (res.error) { setErr(res.error); return; }
    setSentCount(items.length);
    setDone(true);
  }

  const label = (viText: string, enText: string) => (
    <div className="text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: '#92600A' }}>
      {viText} <span className="font-medium normal-case" style={{ color: '#C9A84C' }}>· {enText}</span>
    </div>
  );
  // 16px inputs — anything smaller makes iOS Safari auto-zoom on focus and the page
  // stays zoomed. minWidth 0 stops native date/time widgets from blowing out flex columns.
  const inputCls = 'w-full rounded-xl px-3 py-2.5 bg-white';
  const inputStyle = { border: '1px solid #E0D49A', color: '#1A4731', fontSize: 16, minWidth: 0, WebkitAppearance: 'none' as const, appearance: 'none' as const };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: '#FFF4CC' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: '1px solid #E0D49A' }}>
          <CheckCircle2 size={44} className="mx-auto mb-3" style={{ color: '#2D6A4F' }} />
          <h1 className="font-bold text-lg" style={{ color: '#1A4731' }}>Đã gửi {sentCount > 1 ? `${sentCount} sản phẩm` : ''}! Lab đã nhận đơn.</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>Order sent — the lab received it.</p>
          <button onClick={resetAll}
            className="mt-5 w-full py-3 rounded-xl font-bold text-white text-sm active:scale-[0.98] transition-transform"
            style={{ backgroundColor: '#1A4731' }}>
            Đặt đơn khác · New order
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FFF4CC' }}>
      <header className="sticky top-0 z-10 text-center py-3.5 px-4" style={{ backgroundColor: '#1A4731', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div className="text-white font-bold text-[15px] leading-tight">La Parisienne — Lab</div>
        <div className="text-xs font-semibold" style={{ color: '#C9A84C' }}>Đặt hàng gấp · Urgent order</div>
      </header>

      <div className="max-w-md mx-auto px-4 py-5 space-y-5 pb-16">
        <div>
          {label('Shop của bạn', 'your shop')}
          <div className="flex gap-2">
            {SHOPS.map(s => (
              <button key={s} onClick={() => setShop(s)}
                className="flex-1 py-2.5 rounded-xl text-[13px] font-bold transition-all active:scale-[0.97]"
                style={shop === s
                  ? { backgroundColor: '#1A4731', color: 'white' }
                  : { backgroundColor: 'white', color: '#1A4731', border: '1px solid #E0D49A' }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <div>
          {label('Sản phẩm', 'products')}

          {items.length > 0 && (
            <div className="space-y-2 mb-3">
              {items.map(i => (
                <div key={i.key} className="rounded-xl p-3 bg-white" style={{ border: '1.5px solid #2D6A4F' }}>
                  <div className="flex items-center gap-3">
                    {i.product.imageUrl
                      ? <img src={i.product.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                      : <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-lg" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold" style={{ color: '#1A4731' }}>{i.product.nameVi}</div>
                      {i.product.sku && <div className="text-[10px] font-mono" style={{ color: '#6B7280' }}>{i.product.sku}</div>}
                    </div>
                    <button onClick={() => removeItem(i.key)} className="p-1.5 shrink-0" style={{ color: '#9CA3AF' }} aria-label="Xóa"><X size={17} /></button>
                  </div>
                  <div className="flex items-center gap-3 mt-2.5">
                    <div className="flex items-center gap-2 rounded-lg px-1.5 py-1" style={{ backgroundColor: '#FBF6E3', border: '1px solid #E0D49A' }}>
                      <button onClick={() => { const v = Math.max(1, i.qty - 1); setItemQty(i.key, v, String(v)); }}
                        className="w-7 h-7 rounded-full flex items-center justify-center active:scale-95" style={{ backgroundColor: 'white', color: '#1A4731', border: '1px solid #E0D49A' }} aria-label="Bớt"><Minus size={13} /></button>
                      <input inputMode="numeric" value={i.qtyInput}
                        onChange={e => { const t = e.target.value; const v = parseInt(t, 10); setItemQty(i.key, !isNaN(v) && v >= 1 ? Math.min(500, v) : i.qty, t); }}
                        onBlur={() => { const v = parseInt(i.qtyInput, 10); const s = isNaN(v) || v < 1 ? 1 : Math.min(500, v); setItemQty(i.key, s, String(s)); }}
                        className="w-9 text-center font-bold outline-none bg-transparent" style={{ color: '#1A4731', fontSize: 16 }} />
                      <button onClick={() => { const v = Math.min(500, i.qty + 1); setItemQty(i.key, v, String(v)); }}
                        className="w-7 h-7 rounded-full flex items-center justify-center text-white active:scale-95" style={{ backgroundColor: '#1A4731' }} aria-label="Thêm"><Plus size={13} /></button>
                    </div>
                    {i.product.isCake && (
                      <input value={i.message} onChange={e => setItems(prev => prev.map(x => x.key === i.key ? { ...x, message: e.target.value } : x))}
                        placeholder="Chữ trên bánh…" className="flex-1 rounded-lg px-2.5 py-1.5 min-w-0"
                        style={{ border: '1px solid #93C5FD', color: '#1A4731', fontSize: 16 }} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
            <input value={query} onChange={e => setQuery(e.target.value)}
              placeholder={items.length > 0 ? 'Thêm sản phẩm khác… · add another' : 'Tên sản phẩm hoặc SKU… · name or SKU'}
              className={`${inputCls} pl-9`} style={inputStyle} />
            {searching && <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: '#2D6A4F', borderTopColor: 'transparent' }} />}
          </div>
          {results.length > 0 && (
            <div className="mt-2 rounded-xl overflow-hidden bg-white" style={{ border: '1px solid #E0D49A', maxHeight: '45vh', overflowY: 'auto' }}>
              {results.map((p, i) => (
                <button key={p.variantId ?? p.ficheId} onClick={() => addProduct(p)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left active:bg-green-50"
                  style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
                  {p.imageUrl
                    ? <img src={p.imageUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                    : <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                  <span className="flex-1 min-w-0 text-sm font-medium truncate" style={{ color: '#1A4731' }}>{p.nameVi}</span>
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold" style={{ color: '#2D6A4F' }}><Plus size={13} /> {p.sku && <span className="font-mono font-normal" style={{ color: '#9CA3AF' }}>{p.sku}</span>}</span>
                </button>
              ))}
            </div>
          )}
          {query.trim() && !searching && results.length === 0 && (
            <p className="text-xs text-center py-2" style={{ color: '#9CA3AF' }}>Không tìm thấy · no match</p>
          )}
        </div>

        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            {label('Ngày giao', 'date')}
            <input type="date" min={today} value={date} onChange={e => setDate(e.target.value)} className={inputCls} style={{ ...inputStyle, height: 46 }} />
          </div>
          <div className="flex-1 min-w-0">
            {label('Giờ cần xong', 'ready by')}
            <input type="time" value={readyTime} onChange={e => setReadyTime(e.target.value)} className={inputCls} style={{ ...inputStyle, height: 46 }} />
          </div>
        </div>

        <div>
          {label('Giao đến', 'deliver to')}
          <select value={deliveredBy} onChange={e => setDeliveredBy(e.target.value)} className={inputCls}
            style={{ border: '1px solid #E0D49A', color: '#1A4731', fontSize: 16, minWidth: 0, height: 46, backgroundColor: 'white' }}>
            <option value="">— Chọn —</option>
            {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        <div>
          {label('Địa chỉ giao (nếu có)', 'delivery address')}
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Địa chỉ giao đến khách…" className={inputCls} style={inputStyle} />
        </div>

        <div>
          {label('Khách hàng', 'customer')}
          <div className="flex gap-2">
            <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Tên khách…" className={inputCls} style={{ ...inputStyle, flex: 1 }} />
            <input type="tel" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="SĐT · 090…" className={inputCls} style={{ ...inputStyle, flex: 1.2 }} />
          </div>
        </div>

        <div>
          {label('Ghi chú', 'free note')}
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            placeholder="Khách đến lấy lúc…, hộp màu…, lưu ý khác…" className={`${inputCls} resize-none`} style={inputStyle} />
        </div>

        {err && (
          <p className="text-sm font-semibold rounded-xl px-3 py-2.5" style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}>{err}</p>
        )}

        <button onClick={submit} disabled={sending || !shop || items.length === 0}
          className="w-full py-3.5 rounded-2xl font-bold text-white text-[15px] inline-flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
          style={{ backgroundColor: '#1A4731' }}>
          <Send size={16} /> {sending ? 'Đang gửi…' : `Gửi đơn hàng${items.length > 1 ? ` (${items.length})` : ''} · Send order`}
        </button>
        <p className="text-[11px] text-center" style={{ color: '#B4B2A9' }}>
          Đơn sẽ vào sản xuất ngay và Lab sẽ nhập vào Odoo sau. · Goes straight to production; the lab enters it in Odoo later.
        </p>
      </div>
    </div>
  );
}
