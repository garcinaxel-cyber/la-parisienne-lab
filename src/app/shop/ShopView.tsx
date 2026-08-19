'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, Cake, CheckCircle2, AlertTriangle, Clock, Loader2, LogOut, User, Phone, MapPin, StickyNote, Pencil } from 'lucide-react';
import type { ShopDeliveryOrder, ShopCake } from './actions';
import type { CheckLine } from '@/lib/delivery-check';

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
  // Axel, 2026-08-19: "ne met pas la possibilite de clicker recu pour une commande du
  // lendemain. je veux pouvoir selectionner aujourd hui ou demain" — a day picker like the
  // assistants' own delivery-check, and tomorrow's lines are view-only even for the shop's own
  // account (confirming a receipt before the delivery has actually happened doesn't mean
  // anything). todayDate/tomorrowDate come from the server (Asia/Ho_Chi_Minh) so "today" can't
  // drift from a client clock in a different timezone.
  const [day, setDay] = useState<'today' | 'tomorrow'>('today');
  const [todayDate, setTodayDate] = useState<string | null>(null);
  const [tomorrowDate, setTomorrowDate] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Record<string, { qty: string; note: string }>>({});
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
    setTodayDate(delRes.today ?? null);
    setTomorrowDate(delRes.tomorrow ?? null);
    setCakes(cakeRes.cakes ?? []);
  }

  // Reference qty is what the assistant already checked (l.qty_checked) — that's what the shop
  // actually got sent — falling back to the original order qty if the assistant hasn't checked
  // it yet. Axel, 2026-08-19: same input+OK / checkmark+pencil interaction as the assistants'
  // own delivery-check screen (Section() in DeliveryCheckOrderView.tsx), not the old
  // button-opens-a-panel pattern. Status ('ok'/'issue') is derived from the diff instead of a
  // manual toggle, mirroring how Section() colors a diff instead of asking for it explicitly.
  function refQty(l: CheckLine): number {
    return l.qty_checked ?? l.qty_expected;
  }

  function updDraft(l: CheckLine, patch: Partial<{ qty: string; note: string }>) {
    setDraft(p => ({ ...p, [l.id]: { qty: p[l.id]?.qty ?? String(refQty(l)), note: p[l.id]?.note ?? '', ...patch } }));
  }

  function startEdit(l: CheckLine & { receipt: { qty_received: number | null; note: string | null } | null }) {
    setDraft(p => ({ ...p, [l.id]: { qty: String(l.receipt?.qty_received ?? refQty(l)), note: l.receipt?.note ?? '' } }));
    setEditing(p => { const n = new Set(p); n.add(l.id); return n; });
  }

  async function submitLine(order: ShopDeliveryOrder, l: CheckLine) {
    const d = draft[l.id];
    if (!d) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    try { localStorage.setItem(NAME_STORAGE_KEY, trimmedName); } catch {}
    const qtyNum = d.qty.trim() === '' ? null : Number(d.qty);
    const status: 'ok' | 'issue' = qtyNum === null || qtyNum !== refQty(l) ? 'issue' : 'ok';
    setSaving(l.id);
    const { confirmReceiptAction } = await import('./actions');
    const res = await confirmReceiptAction({
      checkLineId: l.id, deliveryOrderId: order.header.id,
      qtyReceived: qtyNum, status, note: d.note.trim() || null,
      confirmedByName: trimmedName,
    });
    setSaving(null);
    if (res.ok) { setEditing(p => { const n = new Set(p); n.delete(l.id); return n; }); load(); }
  }

  async function logout() {
    const { createClient } = await import('@/lib/supabase-browser');
    await createClient().auth.signOut();
    router.push('/login');
  }

  const dayDate = day === 'today' ? todayDate : tomorrowDate;
  const filteredOrders = orders?.filter(o => o.header.delivery_date === dayDate) ?? null;
  // Only today's deliveries are confirmable — a tomorrow order hasn't been delivered yet, so
  // "received" wouldn't mean anything. Since the list is already filtered to one day at a time,
  // this only needs to check which tab is active.
  const canConfirm = !readOnly && day === 'today';

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
          <div className="space-y-3">
            <div className="flex gap-1.5">
              <button onClick={() => setDay('today')}
                className="flex-1 text-xs font-bold rounded-lg px-3 py-2"
                style={{ backgroundColor: day === 'today' ? '#F3E8B8' : 'white', color: '#1f2937', border: '1px solid #D1D5DB' }}>
                Hôm nay{todayDate ? ` · ${fmtDate(todayDate)}` : ''}
              </button>
              <button onClick={() => setDay('tomorrow')}
                className="flex-1 text-xs font-bold rounded-lg px-3 py-2"
                style={{ backgroundColor: day === 'tomorrow' ? '#F3E8B8' : 'white', color: '#1f2937', border: '1px solid #D1D5DB' }}>
                Ngày mai{tomorrowDate ? ` · ${fmtDate(tomorrowDate)}` : ''}
              </button>
            </div>
            {!filteredOrders?.length ? (
              <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
                {day === 'today' ? 'Không có đơn giao hôm nay' : 'Không có đơn giao ngày mai'}
              </div>
            ) : (
              <>
              {!readOnly && day === 'today' && (
                <div className="bg-white rounded-2xl px-4 py-2.5 flex items-center gap-2" style={{ border: '1px solid #E5E7EB' }}>
                  <span className="text-xs font-semibold shrink-0" style={{ color: '#6B7280' }}>Xác nhận bởi</span>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Tên của bạn"
                    className="flex-1 rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                </div>
              )}
              {filteredOrders.map(o => (
              <div key={o.header.id} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                <div className="px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                  <div className="text-sm font-bold text-navy">{o.header.order_ref}</div>
                  <div className="text-xs" style={{ color: '#6B7280' }}>{fmtDate(o.header.delivery_date)}</div>
                </div>
                <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                  {o.lines.map(l => {
                    const ref = refQty(l);
                    // Unconfirmed lines are always in the input state; confirmed lines flip back
                    // to it only while the shop is actively editing (pencil pressed) — same
                    // two-state shape as Section()'s `checked` Set in DeliveryCheckOrderView.tsx.
                    const isEditing = !l.receipt || editing.has(l.id);
                    const d = draft[l.id] ?? { qty: String(l.receipt?.qty_received ?? ref), note: l.receipt?.note ?? '' };
                    const qtyNum = Number(d.qty);
                    const isDiff = d.qty.trim() !== '' && qtyNum !== ref;
                    const savedDiff = l.receipt?.qty_received != null ? l.receipt.qty_received - ref : 0;
                    return (
                      <div key={l.id} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-navy truncate">{l.product_name_vi}</div>
                            <div className="text-xs" style={{ color: '#9CA3AF' }}>×{l.qty_expected}</div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {/* What the assistant already checked in the lab — the shop's real
                                reference point, not the original order qty. */}
                            <div className="text-center">
                              <div className="text-[9px] uppercase font-bold tracking-wide" style={{ color: '#9CA3AF' }}>Bếp</div>
                              <div className="text-sm font-bold" style={{ color: l.qty_checked != null ? '#1f2937' : '#D1D5DB' }}>
                                {l.qty_checked != null ? `×${l.qty_checked}` : '—'}
                              </div>
                            </div>
                            {!canConfirm ? (
                              l.receipt ? (
                                <span className="inline-flex items-center gap-1 text-xs font-bold" style={{ color: l.receipt.status === 'ok' ? '#059669' : '#DC2626' }}>
                                  {l.receipt.status === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} ×{l.receipt.qty_received ?? '?'}
                                </span>
                              ) : (
                                <span className="text-xs" style={{ color: '#9CA3AF' }}>Chưa xác nhận</span>
                              )
                            ) : isEditing ? (
                              <div className="flex items-center gap-1.5">
                                <input type="number" value={d.qty} onChange={e => updDraft(l, { qty: e.target.value })}
                                  className="w-14 text-center rounded-lg px-2 py-1.5 text-sm font-bold"
                                  style={{ border: '1px solid', borderColor: isDiff ? '#F87171' : '#D1D5DB' }} />
                                {isDiff && <span className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>{qtyNum - ref > 0 ? '+' : ''}{qtyNum - ref}</span>}
                                <button onClick={() => submitLine(o, l)} disabled={saving === l.id || !name.trim()}
                                  className="text-xs font-bold px-2.5 py-1.5 rounded-lg text-white shrink-0 disabled:opacity-40"
                                  style={{ backgroundColor: '#16A34A' }}>
                                  {saving === l.id ? <Loader2 size={13} className="animate-spin" /> : 'OK'}
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: l.receipt!.status === 'ok' ? '#059669' : '#DC2626' }}>
                                  <CheckCircle2 size={16} /> ×{l.receipt!.qty_received ?? '?'}
                                  {savedDiff !== 0 && <span style={{ color: '#DC2626' }}> ({savedDiff > 0 ? '+' : ''}{savedDiff})</span>}
                                </span>
                                <button onClick={() => startEdit(l)}
                                  className="w-6 h-6 flex items-center justify-center rounded-lg shrink-0" style={{ border: '1px solid #D1D5DB' }}
                                  title="Sửa" aria-label="Sửa">
                                  <Pencil size={12} />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        {isEditing && canConfirm && isDiff && (
                          <div className="mt-2">
                            <input type="text" value={d.note} onChange={e => updDraft(l, { note: e.target.value })}
                              placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                          </div>
                        )}
                        {l.receipt && (
                          <div className="text-[11px] mt-1" style={{ color: '#9CA3AF' }}>
                            {l.receipt.confirmed_by_name}{l.receipt.note ? ` · ${l.receipt.note}` : ''}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              ))}
              </>
            )}
          </div>
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
