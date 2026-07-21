'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useRealtimeRefresh } from '@/lib/useRealtimeRefresh';
import {
  Zap, Plus, X, Search, Store, Phone, User, StickyNote, Truck, MapPin, Clock,
  FileText, CheckCircle2, Trash2, PenLine, Link2,
} from 'lucide-react';

type Order = {
  id: string; name: string; sku: string | null; imageUrl: string | null; team: string | null;
  qty: number; deliveryDate: string; readyTime: string; deliveredBy: string; deliveryAddress: string;
  message: string; notes: string; customerName: string; customerPhone: string;
  source: string; fromShop: boolean;
  needsOdoo: boolean; matchedRef: string | null;
  suggestedRef: string | null; suggestedShop: string | null;
  prodStatus: string | null; qtyProduced: number;
};
type Candidate = { orderRef: string; shop: string | null; deliveryDate: string; name: string; sku: string | null; qty: number };
type ProductChoice = {
  ficheId: string; variantId: string | null; sku: string | null; nameVi: string; nameEn: string;
  imageUrl: string | null; team: string; category: string | null; isCake: boolean;
};

const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];
const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

export default function ExceptionalOrdersView({ orders, candidates, productChoices, today, shopLinkToken = null }: {
  orders: Order[]; candidates: Candidate[]; productChoices: ProductChoice[]; today: string; shopLinkToken?: string | null;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  useRealtimeRefresh('exceptional-orders', [{ table: 'lab_manual_cakes' }, { table: 'lab_assignments' }]);

  const [filter, setFilter] = useState<'all' | 'todo' | 'matched'>('all');
  const [busy, setBusy] = useState<string | null>(null);

  const todoCount = orders.filter(o => o.needsOdoo).length;
  const matchedCount = orders.filter(o => !!o.matchedRef).length;
  const shown = orders.filter(o =>
    filter === 'todo' ? o.needsOdoo : filter === 'matched' ? !!o.matchedRef : true);

  const byDate = new Map<string, Order[]>();
  for (const o of shown) (byDate.get(o.deliveryDate) ?? byDate.set(o.deliveryDate, []).get(o.deliveryDate)!).push(o);
  const dates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

  const prodBadge = (o: Order): { label: string; bg: string; fg: string } | null => {
    switch (o.prodStatus) {
      case 'transferred': return { label: vi ? 'Đã chuyển kho' : 'Sent to stock', bg: '#DBEAFE', fg: '#1D4ED8' };
      case 'done': return { label: vi ? `Đã làm x${o.qtyProduced}` : `Done x${o.qtyProduced}`, bg: '#D1FAE5', fg: '#065F46' };
      case 'in_progress': return { label: vi ? 'Đang sản xuất' : 'In production', bg: '#DBEAFE', fg: '#1D4ED8' };
      case 'partial': return { label: vi ? `Một phần ${o.qtyProduced}/${o.qty}` : `Partial ${o.qtyProduced}/${o.qty}`, bg: '#FEF3C7', fg: '#92600A' };
      case 'blocked': return { label: vi ? 'Bị chặn' : 'Blocked', bg: '#FEE2E2', fg: '#DC2626' };
      case 'cancelled': return { label: vi ? 'Đã hủy' : 'Cancelled', bg: '#E5E7EB', fg: '#6B7280' };
      case 'pending': return { label: vi ? 'Chờ làm' : 'To produce', bg: '#F3F4F6', fg: '#374151' };
      default: return null;
    }
  };

  async function confirmMatch(o: Order) {
    if (!o.suggestedRef) return;
    setBusy(o.id);
    const { confirmMatchAction } = await import('../birthday-cakes/actions');
    await confirmMatchAction(o.id, o.suggestedRef, o.sku ?? undefined);
    setBusy(null); router.refresh();
  }
  async function rejectMatch(o: Order) {
    if (!o.suggestedRef) return;
    setBusy(o.id);
    const { rejectMatchAction } = await import('../birthday-cakes/actions');
    await rejectMatchAction(o.id, o.suggestedRef);
    setBusy(null); router.refresh();
  }
  async function removeOrder(o: Order) {
    setBusy(o.id);
    const { deleteManualCakeAction } = await import('../birthday-cakes/actions');
    await deleteManualCakeAction(o.id);
    setBusy(null); setDeleteFor(null); router.refresh();
  }

  // ── Manual link modal ──
  const [linkFor, setLinkFor] = useState<Order | null>(null);
  async function doManualLink(c: Candidate) {
    if (!linkFor) return;
    setBusy(linkFor.id);
    const { confirmMatchAction } = await import('../birthday-cakes/actions');
    await confirmMatchAction(linkFor.id, c.orderRef, c.sku ?? undefined);
    setLinkFor(null); setBusy(null); router.refresh();
  }

  // ── Delete confirmation ──
  const [deleteFor, setDeleteFor] = useState<Order | null>(null);

  // ── Edit modal ──
  const [editFor, setEditFor] = useState<Order | null>(null);
  const [editForm, setEditForm] = useState({ readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', notes: '', customerName: '', customerPhone: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  function openEdit(o: Order) {
    setEditForm({
      readyTime: o.readyTime, deliveredBy: o.deliveredBy, deliveryAddress: o.deliveryAddress,
      message: o.message, notes: o.notes, customerName: o.customerName, customerPhone: o.customerPhone,
    });
    setEditFor(o);
  }
  async function saveEdit() {
    if (!editFor) return;
    setSavingEdit(true);
    const { updateManualCakeAction } = await import('../birthday-cakes/actions');
    await updateManualCakeAction(editFor.id, {
      readyTime: editForm.readyTime || null, deliveredBy: editForm.deliveredBy || null,
      deliveryAddress: editForm.deliveryAddress || null, message: editForm.message || null,
      notes: editForm.notes.trim() || null, customerName: editForm.customerName.trim() || null,
      customerPhone: editForm.customerPhone.trim() || null,
    });
    setSavingEdit(false); setEditFor(null); router.refresh();
  }

  // ── New order modal (whole catalogue; cake fields shown only for cakes) ──
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ProductChoice | null>(null);
  const [form, setForm] = useState({ qty: '1', date: today, readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', customerName: '', customerPhone: '', notes: '' });

  const filtered = query.trim().length === 0
    ? productChoices.slice(0, 8)
    : productChoices.filter(p => (p.nameVi + ' ' + p.nameEn + ' ' + (p.sku ?? '')).toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);

  function resetModal() {
    setShowNew(false); setCreating(false); setCreateErr(null); setQuery(''); setChosen(null);
    setForm({ qty: '1', date: today, readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', customerName: '', customerPhone: '', notes: '' });
  }
  async function createOrder() {
    if (!chosen) { setCreateErr(vi ? 'Chọn sản phẩm' : 'Choose a product'); return; }
    setCreating(true); setCreateErr(null);
    const { createManualCakeAction } = await import('../birthday-cakes/actions');
    const res = await createManualCakeAction({
      ficheId: chosen.ficheId, variantId: chosen.variantId, sku: chosen.sku,
      nameVi: chosen.nameVi, nameEn: chosen.nameEn, imageUrl: chosen.imageUrl, team: chosen.team,
      qty: Math.max(1, parseInt(form.qty, 10) || 1), deliveryDate: form.date,
      readyTime: form.readyTime || null, deliveredBy: form.deliveredBy || null, deliveryAddress: form.deliveryAddress || null,
      message: chosen.isCake ? (form.message || null) : null,
      customerName: form.customerName.trim() || null, customerPhone: form.customerPhone.trim() || null,
      notes: form.notes.trim() || null,
    });
    setCreating(false);
    if (res.error) { setCreateErr(res.error); return; }
    resetModal(); router.refresh();
  }

  const inputStyle = { border: '1px solid #D1D5DB' };
  const labelCls = 'text-xs font-semibold text-ink-light block';

  // ── Shop link modal ──
  const [showLink, setShowLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const shopUrl = shopLinkToken && typeof window !== 'undefined'
    ? `${window.location.origin}/commande/${shopLinkToken}` : null;
  async function copyLink() {
    if (!shopUrl) return;
    try { await navigator.clipboard.writeText(shopUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }
  async function regenerate() {
    setRegenerating(true);
    const { regenerateShopLinkAction } = await import('./actions');
    await regenerateShopLinkAction();
    setRegenerating(false); setConfirmRegen(false); router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <Zap size={24} className="text-gold" /> {vi ? 'Đơn đặc biệt' : 'Exceptional orders'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {vi
              ? 'Đơn gấp tạo trước khi nhập Odoo — mọi sản phẩm, từ shop hoặc trợ lý.'
              : 'Urgent orders created before Odoo entry — any product, from shops or assistants.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowLink(true)}
            className="px-3 py-2 rounded-xl font-semibold text-sm inline-flex items-center gap-1.5 border" style={{ borderColor: '#E0D49A', color: '#1A4731' }}>
            <Link2 size={15} /> {vi ? 'Link shop' : 'Shop link'}
          </button>
          <button onClick={() => setShowNew(true)}
            className="px-4 py-2 rounded-xl font-bold text-white text-sm inline-flex items-center gap-1.5" style={{ backgroundColor: '#1A4731' }}>
            <Plus size={15} /> {vi ? 'Đơn mới' : 'New order'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {([
          ['all', vi ? 'Tất cả' : 'All', orders.length],
          ['todo', vi ? 'Cần nhập Odoo' : 'To enter in Odoo', todoCount],
          ['matched', vi ? 'Đã liên kết' : 'Matched', matchedCount],
        ] as const).map(([key, label, count]) => (
          <button key={key} onClick={() => setFilter(key)}
            className="px-3 py-1.5 rounded-full text-xs font-bold transition-colors"
            style={filter === key
              ? { backgroundColor: '#1A4731', color: 'white' }
              : { backgroundColor: 'white', border: '1px solid #E0D49A', color: '#1A4731' }}>
            {label} · {count}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="font-semibold text-navy">{vi ? 'Không có đơn đặc biệt' : 'No exceptional orders'}</p>
          <p className="text-sm text-ink-light mt-1">
            {vi ? 'Đơn tạo thủ công (mọi sản phẩm) sẽ hiện ở đây.' : 'Manually created orders (any product) will appear here.'}
          </p>
        </div>
      ) : (
        dates.map(date => (
          <div key={date} className="space-y-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-light">
              {vi ? 'Giao' : 'Delivery'} {new Date(date + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              <span className="text-xs font-normal">· {byDate.get(date)!.length} {vi ? 'đơn' : 'orders'}</span>
              {date < today && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: '#E5E7EB', color: '#6B7280' }}>{vi ? 'Đã qua' : 'Past'}</span>}
            </div>
            {byDate.get(date)!.map(o => {
              const pb = prodBadge(o);
              return (
                <div key={o.id} className="card p-4">
                  <div className="flex items-start gap-3 flex-wrap">
                    {o.imageUrl
                      ? <img src={o.imageUrl} alt="" className="w-11 h-11 rounded-xl object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} />
                      : <div className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center text-lg" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-navy flex items-center gap-2 flex-wrap">
                        ×{o.qty} · {o.name}
                        {o.sku && <span className="text-[10px] font-mono text-ink-light">{o.sku}</span>}
                      </div>
                      <div className="text-xs text-ink-light mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap">
                        <span className="inline-flex items-center gap-1">
                          {o.fromShop ? <Store size={12} /> : <User size={12} />}
                          {o.source || (vi ? 'Trợ lý' : 'Assistant')}
                          {o.fromShop && <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>SHOP</span>}
                        </span>
                        {o.readyTime && <span className="inline-flex items-center gap-1"><Clock size={12} /> {o.readyTime.slice(0, 5)}</span>}
                        {o.deliveredBy && <span className="inline-flex items-center gap-1"><Truck size={12} /> {o.deliveredBy}</span>}
                        {o.customerPhone && <span className="inline-flex items-center gap-1"><Phone size={12} /> {o.customerName ? `${o.customerName} · ` : ''}{o.customerPhone}</span>}
                        {!o.customerPhone && o.customerName && <span className="inline-flex items-center gap-1"><User size={12} /> {o.customerName}</span>}
                      </div>
                      {o.deliveryAddress && (
                        <div className="text-xs text-ink-light mt-1 inline-flex items-center gap-1"><MapPin size={12} /> {o.deliveryAddress}</div>
                      )}
                      {o.message && (
                        <div className="text-xs mt-1 inline-flex items-center gap-1" style={{ color: '#1E40AF' }}>✎ {o.message}</div>
                      )}
                      {o.notes && (
                        <div className="text-xs text-ink-light mt-1 flex items-start gap-1"><StickyNote size={12} className="shrink-0 mt-0.5" /> <span className="italic">{o.notes}</span></div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 items-end shrink-0">
                      {pb && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: pb.bg, color: pb.fg }}>{pb.label}</span>}
                      {o.needsOdoo && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>{vi ? 'Cần nhập Odoo' : 'To enter in Odoo'}</span>}
                      {o.matchedRef && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style={{ backgroundColor: '#D1FAE5', color: '#065F46' }}><CheckCircle2 size={11} /> {o.matchedRef}</span>}
                    </div>
                  </div>

                  {o.needsOdoo && o.suggestedRef && (
                    <div className="mt-3 rounded-xl px-3 py-2.5 flex items-center gap-2 flex-wrap" style={{ backgroundColor: '#FFFBEB', border: '1px solid #FCD34D' }}>
                      <FileText size={15} style={{ color: '#92600A' }} className="shrink-0" />
                      <span className="text-xs flex-1" style={{ color: '#92600A' }}>
                        {vi ? 'Đơn Odoo' : 'Odoo order'} <span className="font-mono font-bold">{o.suggestedRef}</span>{o.suggestedShop ? ` · ${o.suggestedShop}` : ''} — {vi ? 'cùng SKU + ngày giao. Là đơn này?' : 'same SKU + delivery date. Is this it?'}
                      </span>
                      <button onClick={() => confirmMatch(o)} disabled={busy === o.id}
                        className="text-xs font-bold px-3 py-1.5 rounded-full text-white inline-flex items-center gap-1 disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                        <CheckCircle2 size={13} /> {busy === o.id ? '…' : (vi ? 'Liên kết' : 'Link')}
                      </button>
                      <button onClick={() => rejectMatch(o)} disabled={busy === o.id}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full border disabled:opacity-40" style={{ borderColor: '#FCD34D', color: '#92600A' }}>
                        {busy === o.id ? '…' : (vi ? 'Không phải' : 'Not this one')}
                      </button>
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-end gap-2 flex-wrap">
                    {!o.matchedRef && (
                      <button onClick={() => setDeleteFor(o)} disabled={busy === o.id}
                        className="px-2.5 py-2 rounded-xl text-sm text-red-600 border border-red-200 inline-flex items-center gap-1 disabled:opacity-40">
                        <Trash2 size={14} />
                      </button>
                    )}
                    <button onClick={() => openEdit(o)} disabled={busy === o.id}
                      className="px-3 py-2 rounded-xl text-sm font-semibold border inline-flex items-center gap-1.5 disabled:opacity-40" style={{ borderColor: '#E0D49A', color: '#1A4731' }}>
                      <PenLine size={14} /> {vi ? 'Sửa' : 'Edit'}
                    </button>
                    {o.needsOdoo && (
                      <button onClick={() => setLinkFor(o)} disabled={busy === o.id}
                        className="px-3 py-2 rounded-xl text-sm font-semibold border inline-flex items-center gap-1.5 disabled:opacity-40" style={{ borderColor: '#93C5FD', color: '#1E40AF' }}>
                        <Link2 size={14} /> {vi ? 'Liên kết đơn Odoo' : 'Link Odoo order'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}

      {showNew && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={resetModal}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-navy text-lg">{vi ? 'Đơn đặc biệt mới' : 'New exceptional order'}</h2>
              <button onClick={resetModal} className="p-1 text-ink-light"><X size={18} /></button>
            </div>

            <label className={labelCls}>{vi ? 'Sản phẩm (toàn bộ danh mục)' : 'Product (whole catalogue)'}</label>
            {chosen ? (
              <div className="flex items-center gap-3 rounded-xl p-2.5" style={{ backgroundColor: '#F0F9F4', border: '1.5px solid #2D6A4F' }}>
                {chosen.imageUrl
                  ? <img src={chosen.imageUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                  : <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: '#1A4731' }}>{chosen.nameVi}</div>
                  <div className="flex items-center gap-1.5">
                    {chosen.sku && <span className="text-[10px] font-mono text-ink-light">{chosen.sku}</span>}
                    {chosen.category && <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>{chosen.category}</span>}
                  </div>
                </div>
                <button onClick={() => { setChosen(null); setQuery(''); }} className="p-1 text-ink-light"><X size={16} /></button>
              </div>
            ) : (
              <div>
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
                  <input value={query} onChange={ev => setQuery(ev.target.value)} autoFocus
                    placeholder={vi ? 'Tên sản phẩm hoặc SKU…' : 'Product name or SKU…'}
                    className="w-full rounded-lg pl-9 pr-3 py-2 text-sm" style={inputStyle} />
                </div>
                {filtered.length > 0 && (
                  <div className="mt-2 rounded-lg" style={{ border: '1px solid #E5E7EB', maxHeight: '48vh', overflowY: 'auto' }}>
                    {filtered.map((p, i) => (
                      <button key={p.variantId ?? p.ficheId} onClick={() => setChosen(p)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-green-50" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                        {p.imageUrl
                          ? <img src={p.imageUrl} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                          : <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                        <span className="flex-1 min-w-0 text-sm font-medium truncate" style={{ color: '#1A4731' }}>{p.nameVi || p.nameEn || p.sku || '—'}</span>
                        {p.sku && <span className="text-[10px] font-mono text-ink-light shrink-0">{p.sku}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {query.trim() && filtered.length === 0 && (
                  <p className="text-xs text-ink-light text-center py-2">{vi ? 'Không tìm thấy' : 'No match'}</p>
                )}
              </div>
            )}
            {chosen && !TEAMS.includes(chosen.team) && (
              <p className="text-xs text-red-600">{vi ? 'Sản phẩm chưa có đội — hoàn thiện phiếu kỹ thuật.' : 'Product has no team — complete the recipe card.'}</p>
            )}

            {chosen && (<>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>{vi ? 'Số lượng' : 'Quantity'}</label>
                <input type="number" min={1} value={form.qty} onChange={ev => setForm(f => ({ ...f, qty: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
              <div>
                <label className={labelCls}>{vi ? 'Ngày giao' : 'Delivery date'}</label>
                <input type="date" value={form.date} onChange={ev => setForm(f => ({ ...f, date: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
              <div>
                <label className={labelCls}>{vi ? 'Cần xong lúc' : 'Ready by'}</label>
                <input type="time" value={form.readyTime} onChange={ev => setForm(f => ({ ...f, readyTime: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
              <div>
                <label className={labelCls}>{vi ? 'Giao đến' : 'Deliver to'}</label>
                <select value={form.deliveredBy} onChange={ev => setForm(f => ({ ...f, deliveredBy: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ ...inputStyle, backgroundColor: 'white' }}>
                  <option value="">{vi ? '— Chọn —' : '— Select —'}</option>
                  {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>{vi ? 'Địa chỉ giao' : 'Delivery address'}</label>
              <input type="text" value={form.deliveryAddress} onChange={ev => setForm(f => ({ ...f, deliveryAddress: ev.target.value }))} placeholder={vi ? 'Địa chỉ khách…' : 'Customer address…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
            </div>
            {chosen.isCake && (
              <div>
                <label className={labelCls}>{vi ? 'Lời chúc (chữ trên bánh)' : 'Message (text on the cake)'}</label>
                <input type="text" value={form.message} onChange={ev => setForm(f => ({ ...f, message: ev.target.value }))} placeholder={vi ? 'Chữ trên bánh…' : 'Text on the cake…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #93C5FD' }} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>{vi ? 'Tên khách' : 'Customer name'}</label>
                <input type="text" value={form.customerName} onChange={ev => setForm(f => ({ ...f, customerName: ev.target.value }))} placeholder={vi ? 'Tên khách hàng…' : 'Customer…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
              <div>
                <label className={labelCls}>{vi ? 'SĐT khách' : 'Customer phone'}</label>
                <input type="tel" value={form.customerPhone} onChange={ev => setForm(f => ({ ...f, customerPhone: ev.target.value }))} placeholder="090…" className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
            </div>
            <div>
              <label className={labelCls}>{vi ? 'Ghi chú' : 'Free note'}</label>
              <textarea value={form.notes} onChange={ev => setForm(f => ({ ...f, notes: ev.target.value }))} rows={2} placeholder={vi ? 'Ghi chú thêm…' : 'Anything useful…'} className="w-full rounded-lg px-2 py-1.5 text-sm resize-none" style={inputStyle} />
            </div>
            </>)}

            {createErr && <p className="text-xs text-red-600">{createErr}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={resetModal} className="flex-1 py-2.5 rounded-xl font-semibold border border-gray-200 text-gray-500">{vi ? 'Hủy' : 'Cancel'}</button>
              <button onClick={createOrder} disabled={creating || !chosen} className="flex-1 py-2.5 rounded-xl font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                {creating ? '…' : (vi ? 'Tạo đơn' : 'Create order')}
              </button>
            </div>
          </div>
        </div>
      )}

      {editFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => !savingEdit && setEditFor(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-navy text-lg">{vi ? 'Sửa đơn' : 'Edit order'}</h2>
                <p className="text-xs text-ink-light">×{editFor.qty} · {editFor.name}</p>
              </div>
              <button onClick={() => setEditFor(null)} className="p-1 text-ink-light"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>{vi ? 'Cần xong lúc' : 'Ready by'}</label>
                <input type="time" value={editForm.readyTime} onChange={ev => setEditForm(f => ({ ...f, readyTime: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
              <div>
                <label className={labelCls}>{vi ? 'Giao đến' : 'Deliver to'}</label>
                <select value={editForm.deliveredBy} onChange={ev => setEditForm(f => ({ ...f, deliveredBy: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ ...inputStyle, backgroundColor: 'white' }}>
                  <option value="">{vi ? '— Chọn —' : '— Select —'}</option>
                  {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>{vi ? 'Địa chỉ giao' : 'Delivery address'}</label>
              <input type="text" value={editForm.deliveryAddress} onChange={ev => setEditForm(f => ({ ...f, deliveryAddress: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
            </div>
            <div>
              <label className={labelCls}>{vi ? 'Lời chúc (chữ trên bánh)' : 'Message (text on the cake)'}</label>
              <input type="text" value={editForm.message} onChange={ev => setEditForm(f => ({ ...f, message: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #93C5FD' }} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>{vi ? 'Tên khách' : 'Customer name'}</label>
                <input type="text" value={editForm.customerName} onChange={ev => setEditForm(f => ({ ...f, customerName: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
              <div>
                <label className={labelCls}>{vi ? 'SĐT khách' : 'Customer phone'}</label>
                <input type="tel" value={editForm.customerPhone} onChange={ev => setEditForm(f => ({ ...f, customerPhone: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={inputStyle} />
              </div>
            </div>
            <div>
              <label className={labelCls}>{vi ? 'Ghi chú' : 'Free note'}</label>
              <textarea value={editForm.notes} onChange={ev => setEditForm(f => ({ ...f, notes: ev.target.value }))} rows={2} className="w-full rounded-lg px-2 py-1.5 text-sm resize-none" style={inputStyle} />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setEditFor(null)} disabled={savingEdit} className="flex-1 py-2.5 rounded-xl font-semibold border border-gray-200 text-gray-500">{vi ? 'Hủy' : 'Cancel'}</button>
              <button onClick={saveEdit} disabled={savingEdit} className="flex-1 py-2.5 rounded-xl font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                {savingEdit ? '…' : (vi ? 'Lưu' : 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {linkFor && (() => {
        const cands = candidates.filter(c => c.deliveryDate === linkFor.deliveryDate);
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={() => setLinkFor(null)}>
            <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={ev => ev.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-navy text-lg">{vi ? 'Liên kết đơn Odoo' : 'Link to an Odoo order'}</h2>
                <button onClick={() => setLinkFor(null)} className="p-1 text-ink-light"><X size={18} /></button>
              </div>
              <p className="text-xs text-ink-light">
                {vi ? 'Chọn dòng đơn Odoo (cùng ngày giao) tương ứng với' : 'Pick the Odoo order line (same delivery date) that matches'}{' '}
                <span className="font-semibold text-navy">×{linkFor.qty} · {linkFor.name}</span>.
              </p>
              {cands.length === 0 ? (
                <p className="text-sm text-ink-light text-center py-4">
                  {vi ? 'Chưa có dòng đơn Odoo nào cho ngày này' : 'No Odoo order lines for this date yet'}
                </p>
              ) : (
                <div className="rounded-lg" style={{ border: '1px solid #E5E7EB', maxHeight: '55vh', overflowY: 'auto' }}>
                  {cands.map((c, i) => (
                    <button key={`${c.orderRef}-${c.sku}-${i}`} onClick={() => doManualLink(c)} disabled={busy === linkFor.id}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-green-50 disabled:opacity-40" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: '#1A4731' }}>×{c.qty} · {c.name}</div>
                        <div className="text-[11px] text-ink-light flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-bold">{c.orderRef}</span>
                          {c.shop && <span>· {c.shop}</span>}
                        </div>
                      </div>
                      {c.sku && <span className="text-[10px] font-mono text-ink-light shrink-0">{c.sku}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {showLink && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => !regenerating && setShowLink(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-navy text-lg">{vi ? 'Link đặt hàng cho shop' : 'Shop order link'}</h2>
              <button onClick={() => setShowLink(false)} className="p-1 text-ink-light"><X size={18} /></button>
            </div>
            <p className="text-xs text-ink-light">
              {vi
                ? 'MỘT link chung cho tất cả shop — gửi qua Zalo, shop lưu vào màn hình chính. Không cần tài khoản.'
                : 'ONE link shared by all shops — send it on Zalo, they bookmark it. No account needed.'}
            </p>
            {shopUrl ? (
              <>
                <div className="rounded-xl px-3 py-2.5 text-xs font-mono break-all" style={{ backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB', color: '#1A4731' }}>
                  {shopUrl}
                </div>
                <div className="flex gap-2">
                  <button onClick={copyLink}
                    className="flex-1 py-2.5 rounded-xl font-bold text-white text-sm inline-flex items-center justify-center gap-1.5" style={{ backgroundColor: '#1A4731' }}>
                    {copied ? <><CheckCircle2 size={14} /> {vi ? 'Đã copy!' : 'Copied!'}</> : (vi ? 'Copy link' : 'Copy link')}
                  </button>
                  <button onClick={() => setConfirmRegen(true)} disabled={regenerating}
                    className="px-3 py-2.5 rounded-xl font-semibold text-sm border disabled:opacity-40" style={{ borderColor: '#FCA5A5', color: '#DC2626' }}>
                    {vi ? 'Tạo link mới' : 'Regenerate'}
                  </button>
                </div>
                {confirmRegen && (
                  <div className="rounded-xl px-3 py-2.5 space-y-2" style={{ backgroundColor: '#FEF2F2', border: '1px solid #FCA5A5' }}>
                    <p className="text-xs font-semibold" style={{ color: '#DC2626' }}>
                      {vi ? 'Link cũ sẽ ngừng hoạt động ngay. Phải gửi link mới cho các shop. Tiếp tục?' : 'The old link dies instantly — you must send the new one to every shop. Continue?'}
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => setConfirmRegen(false)} disabled={regenerating} className="flex-1 py-2 rounded-lg text-xs font-semibold border border-gray-200 text-gray-500">{vi ? 'Hủy' : 'Cancel'}</button>
                      <button onClick={regenerate} disabled={regenerating} className="flex-1 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ backgroundColor: '#DC2626' }}>
                        {regenerating ? '…' : (vi ? 'Tạo link mới' : 'Regenerate now')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-ink-light">{vi ? 'Chưa có link (chạy migration lab_v23) hoặc link bị tắt.' : 'No link yet (run migration lab_v23) or it was deactivated.'}</p>
                <button onClick={regenerate} disabled={regenerating}
                  className="w-full py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                  {regenerating ? '…' : (vi ? 'Tạo link' : 'Create link')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {deleteFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => busy !== deleteFor.id && setDeleteFor(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3" onClick={ev => ev.stopPropagation()}>
            <h2 className="font-bold text-lg" style={{ color: '#DC2626' }}>{vi ? 'Xóa đơn này?' : 'Delete this order?'}</h2>
            <p className="text-sm text-ink-light">×{deleteFor.qty} · {deleteFor.name}</p>
            <p className="text-xs text-ink-light">
              {vi ? 'Thẻ sản xuất của đơn cũng sẽ bị xóa khỏi trạm.' : 'Its production card will also be removed from the station.'}
            </p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setDeleteFor(null)} disabled={busy === deleteFor.id} className="flex-1 py-2.5 rounded-xl font-semibold border border-gray-200 text-gray-500">{vi ? 'Hủy' : 'Cancel'}</button>
              <button onClick={() => removeOrder(deleteFor)} disabled={busy === deleteFor.id} className="flex-1 py-2.5 rounded-xl font-bold text-white disabled:opacity-50" style={{ backgroundColor: '#DC2626' }}>
                {busy === deleteFor.id ? '…' : (vi ? 'Xóa' : 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
