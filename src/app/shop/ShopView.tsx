'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, Cake, CheckCircle2, AlertTriangle, Clock, Loader2, LogOut, User, Phone, MapPin, StickyNote } from 'lucide-react';
import type { ShopDeliveryOrder, ShopCake } from './actions';

const NAME_STORAGE_KEY = 'lab_shop_confirm_name';

function fmtDate(d: string) {
  const [y, m, day] = d.split('-');
  return `${day}/${m}`;
}

// Shared UI for both the shop's own portal (/shop, editable) and the staff preview
// (/admin/shop-access/[shopName], readOnly — Axel wants staff to see exactly what a shop sees
// from the dashboard, without pretending to confirm receipts on the shop's behalf).
export default function ShopView({ shopName, readOnly = false }: { shopName: string; readOnly?: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<'deliveries' | 'cakes'>('deliveries');
  const [orders, setOrders] = useState<ShopDeliveryOrder[] | null>(null);
  const [cakes, setCakes] = useState<ShopCake[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { qty: string; status: 'ok' | 'issue'; note: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!readOnly) { try { setName(localStorage.getItem(NAME_STORAGE_KEY) ?? ''); } catch {} }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true); setError(null);
    const actions = await import('./actions');
    const [delRes, cakeRes] = await Promise.all([
      readOnly ? actions.getShopDeliveriesForStaffAction(shopName) : actions.getMyShopDeliveriesAction(),
      readOnly ? actions.getShopCakesForStaffAction(shopName) : actions.getMyShopCakesAction(),
    ]);
    setLoading(false);
    if (delRes.error) { setError(delRes.error); return; }
    setOrders(delRes.orders ?? []);
    setCakes(cakeRes.cakes ?? []);
  }

  function startConfirm(lineId: string, qtyExpected: number) {
    setDraft(p => ({ ...p, [lineId]: p[lineId] ?? { qty: String(qtyExpected), status: 'ok', note: '' } }));
    setOpenLine(lineId);
  }

  async function submitConfirm(order: ShopDeliveryOrder, lineId: string) {
    const d = draft[lineId];
    if (!d) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    try { localStorage.setItem(NAME_STORAGE_KEY, trimmedName); } catch {}
    setSaving(lineId);
    const { confirmReceiptAction } = await import('./actions');
    const res = await confirmReceiptAction({
      checkLineId: lineId, deliveryOrderId: order.header.id,
      qtyReceived: d.qty.trim() === '' ? null : Number(d.qty), status: d.status, note: d.note.trim() || null,
      confirmedByName: trimmedName,
    });
    setSaving(null);
    if (res.ok) { setOpenLine(null); load(); }
  }

  async function logout() {
    const { createClient } = await import('@/lib/supabase-browser');
    await createClient().auth.signOut();
    router.push('/login');
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FAF8F3' }}>
      <div className="px-4 py-4 sm:px-6" style={{ backgroundColor: '#1f2937' }}>
        <div className="max-w-xl mx-auto flex items-center justify-between">
          <div>
            <div className="text-white/60 text-xs font-semibold uppercase tracking-widest">La Parisienne Lab{readOnly ? ' · Xem trước' : ''}</div>
            <h1 className="text-white font-serif text-xl font-bold">{shopName}</h1>
          </div>
          {!readOnly && (
            <button onClick={logout} className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10" aria-label="Đăng xuất">
              <LogOut size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-4 space-y-4">
        <div className="flex gap-1.5">
          <button onClick={() => setTab('deliveries')}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'deliveries' ? '#1f2937' : 'white', color: tab === 'deliveries' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Truck size={16} /> Giao hàng
          </button>
          <button onClick={() => setTab('cakes')}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'cakes' ? '#1f2937' : 'white', color: tab === 'cakes' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Cake size={16} /> Bánh sinh nhật
          </button>
        </div>

        {loading ? (
          <div className="text-center py-10 text-sm" style={{ color: '#6B7280' }}>Đang tải…</div>
        ) : error ? (
          <div className="text-center py-10 text-sm font-semibold" style={{ color: '#DC2626' }}>{error}</div>
        ) : tab === 'deliveries' ? (
          !orders?.length ? (
            <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
              Không có đơn giao hôm nay hoặc ngày mai
            </div>
          ) : (
            orders.map(o => (
              <div key={o.header.id} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                <div className="px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                  <div className="text-sm font-bold text-navy">{o.header.order_ref}</div>
                  <div className="text-xs" style={{ color: '#6B7280' }}>{fmtDate(o.header.delivery_date)}</div>
                </div>
                <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                  {o.lines.map(l => {
                    const isOpen = openLine === l.id;
                    const d = draft[l.id];
                    return (
                      <div key={l.id} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-navy truncate">{l.product_name_vi}</div>
                            <div className="text-xs" style={{ color: '#9CA3AF' }}>×{l.qty_expected}</div>
                          </div>
                          {l.receipt ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: l.receipt.status === 'ok' ? '#059669' : '#DC2626' }}>
                              {l.receipt.status === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                              {l.receipt.status === 'ok' ? 'Đã nhận' : 'Có vấn đề'}
                            </span>
                          ) : !readOnly ? (
                            <button onClick={() => startConfirm(l.id, l.qty_expected)}
                              className="text-xs font-bold rounded-lg px-3 py-1.5 shrink-0"
                              style={{ border: '1px solid #D1D5DB' }}>
                              Xác nhận
                            </button>
                          ) : (
                            <span className="text-xs shrink-0" style={{ color: '#9CA3AF' }}>Chưa xác nhận</span>
                          )}
                        </div>
                        {l.receipt && (
                          <div className="text-[11px] mt-1" style={{ color: '#9CA3AF' }}>
                            {l.receipt.confirmed_by_name} · ×{l.receipt.qty_received ?? '?'}{l.receipt.note ? ` · ${l.receipt.note}` : ''}
                          </div>
                        )}
                        {isOpen && d && !readOnly && (
                          <div className="mt-2.5 space-y-2 rounded-xl p-3" style={{ backgroundColor: '#F9FAFB' }}>
                            <div className="flex gap-2">
                              <input type="number" value={d.qty} onChange={e => setDraft(p => ({ ...p, [l.id]: { ...p[l.id], qty: e.target.value } }))}
                                className="w-20 text-center rounded-lg px-2 py-1.5 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
                              <button onClick={() => setDraft(p => ({ ...p, [l.id]: { ...p[l.id], status: 'ok' } }))}
                                className="flex-1 text-xs font-bold rounded-lg px-2 py-1.5"
                                style={{ backgroundColor: d.status === 'ok' ? '#DCFCE7' : 'white', color: d.status === 'ok' ? '#166534' : '#6B7280', border: '1px solid #D1D5DB' }}>
                                Đủ hàng
                              </button>
                              <button onClick={() => setDraft(p => ({ ...p, [l.id]: { ...p[l.id], status: 'issue' } }))}
                                className="flex-1 text-xs font-bold rounded-lg px-2 py-1.5"
                                style={{ backgroundColor: d.status === 'issue' ? '#FEE2E2' : 'white', color: d.status === 'issue' ? '#B91C1C' : '#6B7280', border: '1px solid #D1D5DB' }}>
                                Có vấn đề
                              </button>
                            </div>
                            <input type="text" value={d.note} onChange={e => setDraft(p => ({ ...p, [l.id]: { ...p[l.id], note: e.target.value } }))}
                              placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                            <input type="text" value={name} onChange={e => setName(e.target.value)}
                              placeholder="Tên của bạn" className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                            <div className="flex justify-end gap-2">
                              <button onClick={() => setOpenLine(null)} className="text-xs font-semibold px-3 py-1.5" style={{ color: '#6B7280' }}>Huỷ</button>
                              <button onClick={() => submitConfirm(o, l.id)} disabled={saving === l.id || !name.trim()}
                                className="text-xs font-bold rounded-lg px-3.5 py-1.5 text-white disabled:opacity-40"
                                style={{ backgroundColor: '#16A34A' }}>
                                {saving === l.id ? <Loader2 size={13} className="animate-spin" /> : 'Xác nhận'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )
        ) : (
          !cakes?.length ? (
            <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
              Chưa có bánh sinh nhật nào
            </div>
          ) : (
            <div className="space-y-2.5">
              {cakes.map(c => (
                <div key={c.id} className="bg-white rounded-2xl p-4" style={{ border: '1px solid #E5E7EB' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-bold text-navy">{c.name} ×{c.qty}</div>
                    <span className="inline-flex items-center gap-1 text-xs font-bold shrink-0"
                      style={{ color: c.status === 'confirmed' ? '#059669' : c.status === 'cancelled' ? '#DC2626' : '#D97706' }}>
                      {c.status === 'confirmed' ? <CheckCircle2 size={14} /> : c.status === 'cancelled' ? <AlertTriangle size={14} /> : <Clock size={14} />}
                      {c.status === 'confirmed' ? 'Đã xác nhận' : c.status === 'cancelled' ? 'Đã huỷ' : 'Đang chờ'}
                    </span>
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: '#9CA3AF' }}>{fmtDate(c.deliveryDate)}{c.readyTime ? ` · ${c.readyTime}` : ''}</div>
                  {c.cancelReason && <div className="text-xs mt-1 font-semibold" style={{ color: '#DC2626' }}>{c.cancelReason}</div>}
                  <div className="mt-2 pt-2 space-y-1" style={{ borderTop: '1px solid #F3F4F6' }}>
                    {c.customerName && (
                      <div className="text-xs flex items-center gap-1.5" style={{ color: '#374151' }}><User size={12} /> {c.customerName}</div>
                    )}
                    {c.customerPhone && (
                      <div className="text-xs flex items-center gap-1.5" style={{ color: '#374151' }}><Phone size={12} /> {c.customerPhone}</div>
                    )}
                    {c.deliveryAddress && (
                      <div className="text-xs flex items-center gap-1.5" style={{ color: '#374151' }}><MapPin size={12} /> {c.deliveryAddress}</div>
                    )}
                    {c.note && (
                      <div className="text-xs flex items-start gap-1.5" style={{ color: '#B45309' }}><StickyNote size={12} className="mt-0.5 shrink-0" /> {c.note}</div>
                    )}
                    {!c.customerName && !c.customerPhone && !c.deliveryAddress && !c.note && (
                      <div className="text-xs" style={{ color: '#9CA3AF' }}>Không có thông tin bổ sung</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
