'use client';
import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Loader2, Minus, Plus, Search, Send, Trash2, X, AlertTriangle, Clock } from 'lucide-react';
import type { ShopStaffName, ShopManagerCatalogProduct, ShopTransfer } from './actions';
import { thumb } from '@/lib/img-thumb';
import { NamePicker } from './ShopView';

// "Chuyển kho" — inter-shop stock transfers (Axel, 2026-09-07). Same visual language as the
// Đặt hàng tab (category chips + search + cart, manager PIN modal), split into: incoming
// transfers to receive (top, since that's the action the other shop is waiting on), a new
// outgoing transfer, and the last 30 days of history in both directions. Odoo side is handled
// entirely by the server actions — this component never knows about pickings beyond the name.

const SENDER_NAME_KEY = 'lab_shop_transfer_sender_name';
const RECEIVER_NAME_KEY = 'lab_shop_transfer_receiver_name';

type CartLine = { sku: string; name: string; qty: number; note: string; imageUrl: string | null; category: string | null };

const shortShop = (s: string) => s.replace(/^La Paris\s+/i, '');
function fmtDT(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
}

export default function ShopTransfersTab({ shopName, readOnly, staffNames, onManageStaff, setZoomImage, transfers, reload }: {
  shopName: string;
  readOnly: boolean;
  staffNames: ShopStaffName[] | null;
  onManageStaff: () => void;
  setZoomImage: (url: string | null) => void;
  transfers: ShopTransfer[] | null;
  reload: () => Promise<void>;
}) {
  const shopArg = readOnly ? shopName : undefined;
  const [peers, setPeers] = useState<string[] | null>(null);
  const [canTransfer, setCanTransfer] = useState(true);

  // ── new outgoing transfer ──
  const [toShop, setToShop] = useState<string | null>(null);
  const [senderName, setSenderName] = useState('');
  const [note, setNote] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShopManagerCatalogProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ transfer: ShopTransfer; assigned?: boolean } | null>(null);

  // ── receiving ──
  const [receiverName, setReceiverName] = useState('');
  const [recvQty, setRecvQty] = useState<Record<string, Record<string, number>>>({}); // transferId -> sku -> qty
  const [recvConfirm, setRecvConfirm] = useState<ShopTransfer | null>(null);
  const [recvSubmitting, setRecvSubmitting] = useState(false);
  const [recvMsg, setRecvMsg] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelAsk, setCancelAsk] = useState<ShopTransfer | null>(null);
  const [globalMsg, setGlobalMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      setSenderName(localStorage.getItem(SENDER_NAME_KEY) ?? '');
      setReceiverName(localStorage.getItem(RECEIVER_NAME_KEY) ?? '');
    } catch { /* ignore */ }
    (async () => {
      const actions = await import('./actions');
      const [p, c] = await Promise.all([actions.getTransferPeersAction(shopArg), actions.getManagerOrderCategoriesAction(shopArg)]);
      setPeers(p.peers ?? []);
      setCanTransfer(p.canTransfer ?? false);
      setCategories(c.categories ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { try { if (senderName) localStorage.setItem(SENDER_NAME_KEY, senderName); } catch { /* ignore */ } }, [senderName]);
  useEffect(() => { try { if (receiverName) localStorage.setItem(RECEIVER_NAME_KEY, receiverName); } catch { /* ignore */ } }, [receiverName]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 && !categoryFilter) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const actions = await import('./actions');
      const res = await actions.searchManagerOrderProductsAction(q, shopArg, categoryFilter ?? undefined);
      setSearching(false);
      setResults(res.products ?? []);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, categoryFilter]);

  function setQtyForProduct(p: ShopManagerCatalogProduct, qty: number) {
    setCart(prev => {
      const q = Math.max(0, Math.floor(qty));
      const existing = prev.find(l => l.sku === p.sku);
      if (!existing) return q > 0 ? [...prev, { sku: p.sku, name: p.name, qty: q, note: '', imageUrl: p.imageUrl, category: p.category }] : prev;
      if (q === 0) return prev.filter(l => l.sku !== p.sku);
      return prev.map(l => l.sku === p.sku ? { ...l, qty: q } : l);
    });
  }
  function updateQty(sku: string, qty: number) {
    const q = Math.max(0, Math.floor(Number(qty) || 0));
    setCart(prev => q === 0 ? prev.filter(l => l.sku !== sku) : prev.map(l => l.sku === sku ? { ...l, qty: q } : l));
  }

  const cartUnits = cart.reduce((a, l) => a + l.qty, 0);

  async function confirmSend() {
    if (!pin.trim()) { setConfirmMsg('Nhập mã PIN quản lý'); return; }
    if (!toShop) { setConfirmMsg('Chọn kho nhận'); return; }
    setSubmitting(true); setConfirmMsg(null);
    const actions = await import('./actions');
    const res = await actions.submitShopTransferAction({
      pin: pin.trim(), shopName: shopArg, toShop, sentByName: senderName.trim(), note: note.trim() || undefined,
      lines: cart.filter(l => l.qty > 0).map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note.trim() || undefined, category: l.category, imageUrl: l.imageUrl })),
    });
    setSubmitting(false);
    if (res.error || !res.transfer) { setConfirmMsg(res.error ?? 'Lỗi không rõ'); return; }
    setPendingConfirm(false); setPin('');
    setResult({ transfer: res.transfer, assigned: res.assigned });
    setCart([]); setNote(''); setQuery(''); setCategoryFilter(null);
    await reload();
  }

  function recvValue(t: ShopTransfer, sku: string, fallback: number) {
    return recvQty[t.id]?.[sku] ?? fallback;
  }
  function setRecv(t: ShopTransfer, sku: string, qty: number, max: number) {
    const q = Math.min(max, Math.max(0, Math.floor(Number(qty) || 0)));
    setRecvQty(prev => ({ ...prev, [t.id]: { ...(prev[t.id] ?? {}), [sku]: q } }));
  }

  async function confirmReceive() {
    if (!recvConfirm) return;
    if (!receiverName.trim()) { setRecvMsg('Chọn tên người nhận'); return; }
    setRecvSubmitting(true); setRecvMsg(null);
    const actions = await import('./actions');
    const res = await actions.receiveShopTransferAction({
      shopName: shopArg, transferId: recvConfirm.id, receivedByName: receiverName.trim(),
      lines: recvConfirm.lines.map(l => ({ sku: l.sku, qtyReceived: recvValue(recvConfirm, l.sku, l.qtySent) })),
    });
    setRecvSubmitting(false);
    if (res.error) { setRecvMsg(res.error); return; }
    setRecvConfirm(null);
    setGlobalMsg(res.warning ? `✅ Đã nhận ${recvConfirm.ref} · ⚠ ${res.warning}` : `✅ Đã nhận ${recvConfirm.ref} — kho Odoo đã cập nhật`);
    await reload();
  }

  async function doCancel(t: ShopTransfer) {
    if (!senderName.trim()) { setGlobalMsg('Chọn tên của bạn (mục Gửi đi) trước khi huỷ'); setCancelAsk(null); return; }
    setCancelling(t.id);
    const actions = await import('./actions');
    const res = await actions.cancelShopTransferAction({ shopName: shopArg, transferId: t.id, byName: senderName.trim() });
    setCancelling(null); setCancelAsk(null);
    setGlobalMsg(res.error ? `Không huỷ được: ${res.error}` : `✖ Đã huỷ ${t.ref}`);
    await reload();
  }

  const incomingPending = (transfers ?? []).filter(t => t.toShop === shopName && t.status === 'sent');
  const outgoingPending = (transfers ?? []).filter(t => t.fromShop === shopName && t.status === 'sent');
  const history = (transfers ?? []).filter(t => t.status !== 'sent');

  const statusBadge = (t: ShopTransfer) => t.status === 'received'
    ? <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#DCFCE7', color: '#166534' }}>ĐÃ NHẬN</span>
    : t.status === 'cancelled'
      ? <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#F3F4F6', color: '#6B7280' }}>ĐÃ HUỶ</span>
      : <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>CHỜ NHẬN</span>;

  if (!canTransfer && peers !== null) {
    return (
      <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
        Cửa hàng của bạn chưa được bật tính năng chuyển kho.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {globalMsg && (
        <div className="flex items-start justify-between gap-2 rounded-xl px-3.5 py-2.5 text-xs font-semibold" style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0', color: '#166534' }}>
          <span>{globalMsg}</span>
          <button onClick={() => setGlobalMsg(null)}><X size={14} /></button>
        </div>
      )}

      {/* ── Incoming, waiting for this shop ── */}
      {incomingPending.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide px-1" style={{ color: '#92400E' }}>📥 Nhận về — {incomingPending.length} phiếu chờ nhận</div>
          {incomingPending.map(t => (
            <div key={t.id} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #FCD34D' }}>
              <div className="px-4 py-2.5 flex items-center justify-between gap-2" style={{ backgroundColor: '#FFFBEB' }}>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-navy truncate">Từ {shortShop(t.fromShop)} · {t.ref}</div>
                  <div className="text-[11px]" style={{ color: '#6B7280' }}>Gửi {fmtDT(t.sentAt)}{t.sentByName ? ` · ${t.sentByName}` : ''}{t.odooPickingName ? ` · Odoo ${t.odooPickingName}` : ''}</div>
                </div>
                <span className="text-xs font-bold shrink-0">{t.lineCount} SP · {t.unitCount} cái</span>
              </div>
              {t.note && <div className="px-4 py-1.5 text-xs" style={{ color: '#6B7280', borderTop: '1px solid #FEF3C7' }}>📝 {t.note}</div>}
              <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                {t.lines.map(l => {
                  const v = recvValue(t, l.sku, l.qtySent);
                  const diff = v !== l.qtySent;
                  return (
                    <div key={l.id} className="px-4 py-2 flex items-center gap-2.5">
                      {l.imageUrl ? (
                        <button type="button" onClick={() => setZoomImage(l.imageUrl!)} className="shrink-0 w-9 h-9 rounded overflow-hidden"><img src={thumb(l.imageUrl, 80)} alt="" className="w-full h-full object-cover" /></button>
                      ) : <div className="shrink-0 w-9 h-9 rounded" style={{ backgroundColor: '#F3F4F6' }} />}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>{l.name}</div>
                        <div className="text-[11px]" style={{ color: '#9CA3AF' }}>Gửi: {l.qtySent}{l.note ? ` · ${l.note}` : ''}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => setRecv(t, l.sku, v - 1, l.qtySent)} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ border: '1px solid #D1D5DB' }}><Minus size={12} /></button>
                        <input type="number" value={v} min={0} max={l.qtySent} onChange={e => setRecv(t, l.sku, Number(e.target.value), l.qtySent)}
                          className="w-12 text-center rounded-lg py-1 text-sm font-bold" style={{ border: `1px solid ${diff ? '#F59E0B' : '#D1D5DB'}`, backgroundColor: diff ? '#FFFBEB' : 'white' }} />
                        <button onClick={() => setRecv(t, l.sku, v + 1, l.qtySent)} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ border: '1px solid #D1D5DB' }}><Plus size={12} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-2.5 space-y-2" style={{ borderTop: '1px solid #F3F4F6' }}>
                <div>
                  <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Người nhận</div>
                  <NamePicker value={receiverName} onChange={setReceiverName} names={staffNames} onManage={onManageStaff} />
                </div>
                <button onClick={() => { setRecvMsg(null); setRecvConfirm(t); }} disabled={!receiverName.trim()}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40" style={{ backgroundColor: '#16A34A' }}>
                  <CheckCircle2 size={14} /> Xác nhận đã nhận hàng
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Outgoing, not yet received ── */}
      {outgoingPending.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide px-1" style={{ color: '#6B7280' }}>📤 Đã gửi — chờ kho nhận xác nhận</div>
          {outgoingPending.map(t => (
            <div key={t.id} className="bg-white rounded-2xl px-4 py-3 space-y-1.5" style={{ border: '1px solid #E5E7EB' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-bold text-navy truncate">→ {shortShop(t.toShop)} · {t.ref}</div>
                {statusBadge(t)}
              </div>
              <div className="text-[11px]" style={{ color: '#6B7280' }}>Gửi {fmtDT(t.sentAt)}{t.sentByName ? ` · ${t.sentByName}` : ''} · {t.lineCount} SP · {t.unitCount} cái{t.odooPickingName ? ` · Odoo ${t.odooPickingName}` : ''}</div>
              <div className="text-xs" style={{ color: '#374151' }}>{t.lines.map(l => `${l.name} ×${l.qtySent}`).join(' · ')}</div>
              <button onClick={() => setCancelAsk(t)} disabled={cancelling === t.id}
                className="text-xs font-bold inline-flex items-center gap-1" style={{ color: '#DC2626' }}>
                {cancelling === t.id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Huỷ phiếu chuyển
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── New outgoing transfer ── */}
      {result ? (
        <div className="bg-white rounded-2xl p-6 space-y-3 text-center" style={{ border: '1px solid #E5E7EB' }}>
          <CheckCircle2 size={32} className="mx-auto" style={{ color: '#16A34A' }} />
          <div className="text-sm font-bold text-navy">Đã gửi phiếu chuyển kho</div>
          <div className="text-xs" style={{ color: '#6B7280' }}>→ {result.transfer.toShop} · {result.transfer.lineCount} SP · {result.transfer.unitCount} cái</div>
          <div className="rounded-xl px-4 py-3" style={{ backgroundColor: '#F9FAFB' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Mã phiếu</div>
            <div className="text-lg font-bold" style={{ color: '#1f2937' }}>{result.transfer.ref}</div>
            {result.transfer.odooPickingName && <div className="text-xs" style={{ color: '#6B7280' }}>Odoo: {result.transfer.odooPickingName}</div>}
          </div>
          {result.assigned === false && (
            <div className="text-[11px] text-left rounded-lg px-3 py-2" style={{ backgroundColor: '#FFFBEB', color: '#92400E' }}>
              ⚠ Odoo chưa đủ tồn kho để giữ hàng cho phiếu này — hàng vẫn gửi bình thường; kho nhận xác nhận số lượng thật khi nhận.
            </div>
          )}
          <div className="text-xs" style={{ color: '#6B7280' }}>Kho Odoo sẽ cập nhật khi {shortShop(result.transfer.toShop)} xác nhận đã nhận.</div>
          <button onClick={() => setResult(null)} className="w-full text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: '#1f2937' }}>Tạo phiếu khác</button>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-2xl p-4 space-y-2.5" style={{ border: '1px solid #E5E7EB' }}>
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>📤 Gửi đi — phiếu chuyển kho mới</div>
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Kho nhận</div>
              <div className="flex flex-wrap gap-1.5">
                {peers === null ? <span className="text-xs" style={{ color: '#9CA3AF' }}>Đang tải…</span> : peers.map(p => (
                  <button key={p} onClick={() => setToShop(prev => prev === p ? null : p)}
                    className="text-xs font-semibold rounded-full px-3 py-1.5"
                    style={{ backgroundColor: toShop === p ? '#1f2937' : 'white', color: toShop === p ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
                    {shortShop(p)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Người gửi</div>
              <NamePicker value={senderName} onChange={setSenderName} names={staffNames} onManage={onManageStaff} />
            </div>
            <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Ghi chú chung (tuỳ chọn)"
              className="w-full rounded-lg px-2.5 py-1.5 text-xs" style={{ border: '1px solid #D1D5DB' }} />
            <div className="text-[11px]" style={{ color: '#6B7280' }}>Ai cũng có thể chuẩn bị phiếu; gửi đi cần mã PIN quản lý. Odoo tạo phiếu chuyển nội bộ ngay, tồn kho đổi khi kho nhận xác nhận.</div>
          </div>

          <div className="bg-white rounded-2xl p-4 space-y-2" style={{ border: '1px solid #E5E7EB' }}>
            <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Thêm sản phẩm</div>
            {categories.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-0.5 px-0.5" style={{ WebkitOverflowScrolling: 'touch' }}>
                <button onClick={() => setCategoryFilter(null)} className="shrink-0 text-xs font-semibold rounded-full px-3 py-1.5"
                  style={{ backgroundColor: !categoryFilter ? '#1f2937' : 'white', color: !categoryFilter ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>Tất cả</button>
                {categories.map(cat => (
                  <button key={cat} onClick={() => setCategoryFilter(prev => prev === cat ? null : cat)} className="shrink-0 text-xs font-semibold rounded-full px-3 py-1.5"
                    style={{ backgroundColor: categoryFilter === cat ? '#1f2937' : 'white', color: categoryFilter === cat ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>{cat}</button>
                ))}
              </div>
            )}
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
              <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm sản phẩm…"
                className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
            </div>
            {(query.trim().length >= 2 || categoryFilter) && (
              <div className="rounded-lg overflow-y-auto overscroll-contain max-h-72" style={{ border: '1px solid #E5E7EB', WebkitOverflowScrolling: 'touch' }}>
                {searching ? <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Đang tìm…</div>
                  : !results.length ? <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Không tìm thấy</div>
                  : results.map(p => {
                    const inCart = cart.find(l => l.sku === p.sku)?.qty ?? 0;
                    return (
                      <div key={p.sku} className="px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2.5" style={{ borderColor: '#F3F4F6' }}>
                        {p.imageUrl ? (
                          <button type="button" onClick={() => setZoomImage(p.imageUrl!)} className="shrink-0 w-10 h-10 rounded overflow-hidden"><img src={thumb(p.imageUrl, 80)} alt="" className="w-full h-full object-cover" /></button>
                        ) : <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: '#F3F4F6' }} />}
                        <span className="overflow-x-auto whitespace-nowrap no-scrollbar flex-1 min-w-0" style={{ WebkitOverflowScrolling: 'touch' }}>{p.name}<span style={{ color: '#9CA3AF' }}> · {p.sku}</span></span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button onClick={() => setQtyForProduct(p, inCart - 1)} disabled={inCart <= 0} className="w-6 h-6 rounded-md flex items-center justify-center disabled:opacity-30" style={{ border: '1px solid #D1D5DB' }}><Minus size={11} /></button>
                          <span className="w-5 text-center text-xs font-bold">{inCart}</span>
                          <button onClick={() => setQtyForProduct(p, inCart + 1)} className="w-6 h-6 rounded-md flex items-center justify-center" style={{ border: '1px solid #D1D5DB' }}><Plus size={11} /></button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {!cart.length ? (
            <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ color: '#9CA3AF', border: '1px solid #E5E7EB' }}>Chưa có sản phẩm — tìm và thêm ở trên</div>
          ) : (
            <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
              <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                {cart.map(l => (
                  <div key={l.sku} className="px-4 py-2.5 space-y-1.5">
                    <div className="flex items-center gap-2.5">
                      {l.imageUrl ? <img src={thumb(l.imageUrl, 80)} alt="" className="shrink-0 w-10 h-10 rounded object-cover" /> : <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: '#F3F4F6' }} />}
                      <span className="text-sm font-semibold overflow-x-auto whitespace-nowrap no-scrollbar flex-1 min-w-0" style={{ WebkitOverflowScrolling: 'touch' }}>{l.name}</span>
                      <button onClick={() => updateQty(l.sku, 0)} className="shrink-0"><Trash2 size={14} style={{ color: '#DC2626' }} /></button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => updateQty(l.sku, l.qty - 1)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ border: '1px solid #D1D5DB' }}><Minus size={12} /></button>
                      <input type="number" value={l.qty} onChange={e => updateQty(l.sku, Number(e.target.value))} className="w-14 text-center rounded-lg py-1 text-sm font-bold shrink-0" style={{ border: '1px solid #D1D5DB' }} />
                      <button onClick={() => updateQty(l.sku, l.qty + 1)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ border: '1px solid #D1D5DB' }}><Plus size={12} /></button>
                      <input type="text" value={l.note} onChange={e => setCart(prev => prev.map(x => x.sku === l.sku ? { ...x, note: e.target.value } : x))}
                        placeholder="Ghi chú (tuỳ chọn)" className="flex-1 min-w-0 rounded-lg px-2.5 py-1 text-xs" style={{ border: '1px solid #D1D5DB' }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2 text-xs font-semibold flex justify-between" style={{ backgroundColor: '#F9FAFB', color: '#374151' }}>
                <span>{cart.length} SP</span><span>{cartUnits} cái</span>
              </div>
            </div>
          )}

          <button onClick={() => { setPin(''); setConfirmMsg(null); setPendingConfirm(true); }}
            disabled={!cart.length || !toShop || !senderName.trim()}
            className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40" style={{ backgroundColor: '#1f2937' }}>
            <Send size={14} /> Gửi chuyển kho{toShop ? ` → ${shortShop(toShop)}` : ''}
          </button>
        </>
      )}

      {/* ── History ── */}
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase tracking-wide px-1" style={{ color: '#6B7280' }}><Clock size={12} className="inline mr-1" />Lịch sử 30 ngày</div>
        {transfers === null ? (
          <div className="text-center py-4 text-xs" style={{ color: '#9CA3AF' }}>Đang tải…</div>
        ) : !history.length ? (
          <div className="bg-white rounded-2xl p-4 text-center text-xs" style={{ color: '#9CA3AF', border: '1px solid #E5E7EB' }}>Chưa có phiếu chuyển kho nào</div>
        ) : history.map(t => {
          const out = t.fromShop === shopName;
          const diffs = t.lines.filter(l => l.qtyReceived != null && l.qtyReceived !== l.qtySent);
          return (
            <div key={t.id} className="bg-white rounded-2xl px-4 py-3 space-y-1" style={{ border: '1px solid #E5E7EB' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-bold text-navy truncate">{out ? `→ ${shortShop(t.toShop)}` : `← ${shortShop(t.fromShop)}`} · {t.ref}</div>
                {statusBadge(t)}
              </div>
              <div className="text-[11px]" style={{ color: '#6B7280' }}>
                Gửi {fmtDT(t.sentAt)}{t.sentByName ? ` · ${t.sentByName}` : ''}
                {t.receivedAt ? ` · Nhận ${fmtDT(t.receivedAt)}${t.receivedByName ? ` · ${t.receivedByName}` : ''}` : ''}
                {t.cancelledAt ? ` · Huỷ ${fmtDT(t.cancelledAt)}${t.cancelledByName ? ` · ${t.cancelledByName}` : ''}` : ''}
                {t.odooPickingName ? ` · Odoo ${t.odooPickingName}` : ''}
              </div>
              <div className="text-xs" style={{ color: '#374151' }}>{t.lines.map(l => `${l.name} ×${l.qtyReceived ?? l.qtySent}`).join(' · ')}</div>
              {diffs.length > 0 && (
                <div className="text-[11px] font-semibold" style={{ color: '#B45309' }}>
                  ⚠ Chênh lệch: {diffs.map(l => `${l.name} ${(l.qtyReceived ?? 0) - l.qtySent}`).join(', ')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── PIN modal (send) ── */}
      {pendingConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
              <ArrowRightLeft size={12} className="inline mr-1" />Chuyển kho → {toShop ? shortShop(toShop) : '…'} ({cart.length} SP · {cartUnits} cái)
            </div>
            <div className="space-y-1.5">
              {cart.map(l => (
                <div key={l.sku} className="flex items-center gap-2.5 rounded-xl p-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                  {l.imageUrl ? <img src={thumb(l.imageUrl, 80)} alt="" className="shrink-0 w-8 h-8 rounded object-cover" /> : <div className="shrink-0 w-8 h-8 rounded" style={{ backgroundColor: '#E5E7EB' }} />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-navy overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>{l.name}</div>
                    {l.note.trim() && <div className="text-xs" style={{ color: '#9CA3AF' }}>{l.note.trim()}</div>}
                  </div>
                  <span className="text-sm font-bold shrink-0">×{l.qty}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Mã PIN quản lý</div>
              <input type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmSend(); }} placeholder="Mã PIN" autoFocus
                className="w-full text-center tracking-[0.3em] rounded-lg px-3 py-2.5 text-lg font-bold" style={{ border: '1px solid #D1D5DB' }} />
              {confirmMsg && <div className="text-xs font-semibold mt-1.5" style={{ color: '#DC2626' }}>{confirmMsg}</div>}
            </div>
            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>Odoo sẽ tạo phiếu chuyển nội bộ ngay. Có thể huỷ trong app cho đến khi kho nhận xác nhận.</div>
            <div className="flex gap-2">
              <button onClick={() => { setPendingConfirm(false); setPin(''); setConfirmMsg(null); }} className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>Huỷ</button>
              <button onClick={confirmSend} disabled={submitting || !pin.trim()} className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40" style={{ backgroundColor: '#16A34A' }}>
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Gửi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Receive confirm modal ── */}
      {recvConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Xác nhận nhận hàng · {recvConfirm.ref}</div>
            <div className="space-y-1.5">
              {recvConfirm.lines.map(l => {
                const v = recvValue(recvConfirm, l.sku, l.qtySent);
                const diff = v - l.qtySent;
                return (
                  <div key={l.id} className="flex items-center justify-between gap-2 rounded-xl p-2.5" style={{ backgroundColor: diff ? '#FFFBEB' : '#F9FAFB' }}>
                    <div className="text-sm font-semibold overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>{l.name}</div>
                    <div className="text-sm font-bold shrink-0">{v}<span className="text-xs font-normal" style={{ color: '#9CA3AF' }}> / {l.qtySent}</span>{diff ? <span className="text-xs ml-1" style={{ color: '#B45309' }}>({diff})</span> : null}</div>
                  </div>
                );
              })}
            </div>
            {recvConfirm.lines.some(l => recvValue(recvConfirm, l.sku, l.qtySent) !== l.qtySent) && (
              <div className="flex items-start gap-1.5 text-[11px] rounded-lg px-3 py-2" style={{ backgroundColor: '#FFFBEB', color: '#92400E' }}>
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>Có chênh lệch: {recvConfirm.fromIsVirtual
                  ? `chỉ số lượng thực nhận được cộng vào kho Odoo của ${shortShop(recvConfirm.toShop)}`
                  : `phần thiếu vẫn nằm trong kho ${shortShop(recvConfirm.fromShop)} trên Odoo — ${shortShop(recvConfirm.fromShop)} sẽ được báo để ghi hao hụt nếu hàng bị mất`}.</span>
              </div>
            )}
            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>Người nhận: <b>{receiverName}</b>. Tồn kho Odoo của hai cửa hàng sẽ đổi ngay khi bấm xác nhận — không thể hoàn tác trong app.</div>
            {recvMsg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{recvMsg}</div>}
            <div className="flex gap-2">
              <button onClick={() => setRecvConfirm(null)} className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>Quay lại</button>
              <button onClick={confirmReceive} disabled={recvSubmitting} className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40" style={{ backgroundColor: '#16A34A' }}>
                {recvSubmitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Xác nhận
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cancel confirm ── */}
      {cancelAsk && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3">
            <div className="text-sm font-bold text-navy">Huỷ phiếu {cancelAsk.ref}?</div>
            <div className="text-xs" style={{ color: '#6B7280' }}>Phiếu chuyển nội bộ trên Odoo sẽ bị huỷ, {shortShop(cancelAsk.toShop)} sẽ được báo. Người huỷ: <b>{senderName || '—'}</b></div>
            <div className="flex gap-2">
              <button onClick={() => setCancelAsk(null)} className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>Không</button>
              <button onClick={() => doCancel(cancelAsk)} className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: '#DC2626' }}>Huỷ phiếu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
