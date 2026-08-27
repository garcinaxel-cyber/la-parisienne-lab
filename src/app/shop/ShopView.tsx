'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, Cake, Trash2, CheckCircle2, AlertTriangle, Clock, Loader2, LogOut, User, Phone, MapPin, StickyNote, Pencil, Search, ArrowLeft, Settings, Plus, X, Check } from 'lucide-react';
import type { ShopDeliveryOrder, ShopCake, ShopLoss, ShopLossReason, ShopStaffName } from './actions';
import type { CheckLine } from '@/lib/delivery-check';

const LOSS_NAME_STORAGE_KEY = 'lab_shop_loss_name';

// Same result shape as /api/lab/products-search (station/inventory product picker) — reused
// as-is here rather than writing a second search endpoint. main_image_url is already returned
// by that route (dv?.image_url ?? f.image_url) — kept here too so the scrap picker can show a
// thumbnail (helps confirm the right product before an Odoo-bound report, 2026-08-25).
type ProductSearchResult = { id: string; name_vi: string; name_en: string | null; sku: string | null; main_image_url?: string | null };

const NAME_STORAGE_KEY = 'lab_shop_confirm_name';

function fmtDate(d: string) {
  const [y, m, day] = d.split('-');
  return `${day}/${m}`;
}

// Staff roster picker (Axel, 2026-08-27) — a <select> over the shop's managed name list plus a
// small gear button opening the manage modal, used in both the delivery-confirm name field and
// the loss-report name field so there's exactly one roster shared everywhere a name is needed.
// Falls back to showing the current value as its own option if it isn't in the list yet (e.g. a
// name remembered from localStorage from before this picker existed) so nothing gets silently
// blanked out for someone who already had a name saved.
function NamePicker({ value, onChange, names, onManage }: {
  value: string; onChange: (v: string) => void; names: ShopStaffName[] | null; onManage: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <select value={value} onChange={e => onChange(e.target.value)}
        className="flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }}>
        <option value="">Chọn tên…</option>
        {(names ?? []).map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
        {value.trim() && !(names ?? []).some(s => s.name === value) && <option value={value}>{value}</option>}
      </select>
      <button type="button" onClick={onManage}
        className="w-8 h-8 flex items-center justify-center rounded-lg shrink-0" style={{ border: '1px solid #D1D5DB' }}
        aria-label="Quản lý danh sách tên" title="Quản lý danh sách tên">
        <Settings size={14} style={{ color: '#6B7280' }} />
      </button>
    </div>
  );
}

// Shared UI for both the shop's own portal (/shop) and staff testing AS a shop from the admin
// dashboard (/admin/shop-access/[shopName]). `readOnly` originally meant a true read-only
// mirror; Axel, 2026-08-25: "je veux exactement comme les QR code des chefs, dans l admin je
// peux avoir access facilement a leur interface" — staff access is now fully interactive (same
// confirm/scrap actions, same Odoo writes), just banner-flagged so it's never mistaken for the
// shop's own login. The prop name stays `readOnly` for now (only the ONE caller in
// admin/shop-access/[shopName]/page.tsx passes it) but it now means "acting on behalf of
// `shopName` via a staff session" rather than "cannot write".
export default function ShopView({ shopName, readOnly = false }: { shopName: string; readOnly?: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<'deliveries' | 'cakes' | 'losses'>('deliveries');
  const [orders, setOrders] = useState<ShopDeliveryOrder[] | null>(null);
  const [cakes, setCakes] = useState<ShopCake[] | null>(null);
  // ── Pertes (daily loss/scrap) — loaded lazily, only when the tab is first opened, so
  // read-only staff previews and the deliveries/cakes tabs never pay for it.
  const [losses, setLosses] = useState<ShopLoss[] | null>(null);
  const [lossReasons, setLossReasons] = useState<ShopLossReason[] | null>(null);
  const [lossesLoading, setLossesLoading] = useState(false);
  const [lossQuery, setLossQuery] = useState('');
  const [lossResults, setLossResults] = useState<ProductSearchResult[]>([]);
  const [lossSearching, setLossSearching] = useState(false);
  const [lossProduct, setLossProduct] = useState<ProductSearchResult | null>(null);
  const [lossQty, setLossQty] = useState('1');
  const [lossReasonId, setLossReasonId] = useState<number | null>(null);
  const [lossNote, setLossNote] = useState('');
  // Multiple products per report (Axel, 2026-08-25: "la possibilite de scrap plusieurs produit
  // et non un par 1") — each "Thêm vào danh sách" tap snapshots the current product/qty/reason/
  // note into this list and resets the picker for the next item; the actual submit sends every
  // item in the list in one go, each still becoming its own lab_shop_losses row + stock.scrap
  // (Odoo has no native "scrap several products at once" endpoint).
  const [lossItems, setLossItems] = useState<{ id: string; product: ProductSearchResult; qty: number; reasonId: number; reasonName: string; note: string }[]>([]);
  const [lossSubmitting, setLossSubmitting] = useState(false);
  const [lossMsg, setLossMsg] = useState<string | null>(null);
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
  // Full-screen photo viewer, shared by the delivery-check thumbnails and the scrap picker.
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  // Double-check before an actual write: OK/Báo cáo hao hụt open a summary instead of saving
  // immediately (Axel, 2026-08-25: "je voudrais une double verification par securite pour qu ils
  // envoient pas sur odoo n importe quoi"). Snapshotting order/line/qty/note here means the
  // confirm step shows exactly what will be sent even if the draft input keeps changing behind it.
  const [pendingReceipt, setPendingReceipt] = useState<{ order: ShopDeliveryOrder; line: ShopDeliveryOrder['lines'][number]; qty: number | null; note: string } | null>(null);
  const [pendingLoss, setPendingLoss] = useState(false);

  const [lossName, setLossName] = useState('');

  // Staff roster picker (Axel, 2026-08-27): a small managed list per shop so staff pick their
  // name instead of typing it everywhere. Shared between the delivery-confirm name and the
  // loss-report name — one roster, two places it's used. Loaded once at startup; the manage
  // modal (add/rename/delete) is reachable from a small gear button next to either picker.
  const [staffNames, setStaffNames] = useState<ShopStaffName[] | null>(null);
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [newStaffInput, setNewStaffInput] = useState('');
  const [staffBusy, setStaffBusy] = useState<string | null>(null);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [editStaffDraft, setEditStaffDraft] = useState('');

  async function loadStaffNames() {
    const { getShopStaffNamesAction } = await import('./actions');
    const res = await getShopStaffNamesAction(readOnly ? shopName : undefined);
    if (res.names) setStaffNames(res.names);
  }

  async function addStaffName() {
    const clean = newStaffInput.trim();
    if (!clean) return;
    setStaffBusy('add');
    const { addShopStaffNameAction } = await import('./actions');
    const res = await addShopStaffNameAction(clean, readOnly ? shopName : undefined);
    setStaffBusy(null);
    if (res.staffName) {
      setStaffNames(prev => [...(prev ?? []), res.staffName!].sort((a, b) => a.name.localeCompare(b.name)));
      setNewStaffInput('');
    }
  }

  async function saveStaffRename(id: string) {
    const clean = editStaffDraft.trim();
    if (!clean) return;
    setStaffBusy(id);
    const { renameShopStaffNameAction } = await import('./actions');
    const res = await renameShopStaffNameAction(id, clean, readOnly ? shopName : undefined);
    setStaffBusy(null);
    if (res.ok) {
      setStaffNames(prev => (prev ?? []).map(s => s.id === id ? { ...s, name: clean } : s).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingStaffId(null);
    }
  }

  async function deleteStaffName(id: string) {
    setStaffBusy(id);
    const { removeShopStaffNameAction } = await import('./actions');
    const res = await removeShopStaffNameAction(id, readOnly ? shopName : undefined);
    setStaffBusy(null);
    if (res.ok) setStaffNames(prev => (prev ?? []).filter(s => s.id !== id));
  }

  useEffect(() => {
    if (!readOnly) {
      try { setName(localStorage.getItem(NAME_STORAGE_KEY) ?? ''); } catch {}
      try { setLossName(localStorage.getItem(LOSS_NAME_STORAGE_KEY) ?? ''); } catch {}
    }
    load();
    loadStaffNames();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== 'losses' || losses !== null) return;
    loadLosses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function loadLosses() {
    setLossesLoading(true);
    const actions = await import('./actions');
    const [lossesRes, reasonsRes] = await Promise.all([
      readOnly ? actions.getShopLossesForStaffAction(shopName) : actions.getMyShopLossesAction(),
      lossReasons ? Promise.resolve({ reasons: lossReasons }) : actions.getShopLossReasonsAction(),
    ]);
    setLossesLoading(false);
    if (lossesRes.losses) setLosses(lossesRes.losses);
    if (reasonsRes.reasons) setLossReasons(reasonsRes.reasons);
  }

  useEffect(() => {
    const q = lossQuery.trim();
    if (q.length < 2) { setLossResults([]); return; }
    const t = setTimeout(async () => {
      setLossSearching(true);
      try {
        const res = await fetch(`/api/lab/products-search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setLossResults(Array.isArray(data) ? data : []);
      } catch { setLossResults([]); }
      setLossSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [lossQuery]);

  // Snapshots the currently-filled product/qty/reason/note into the list, then clears the
  // picker so the shop can immediately search the next product.
  function addLossItem() {
    if (!lossProduct || !lossReasonId) return;
    const qtyNum = Number(lossQty);
    if (!(qtyNum > 0)) return;
    const reason = lossReasons?.find(r => r.id === lossReasonId);
    if (!reason) return;
    setLossItems(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      product: lossProduct, qty: qtyNum, reasonId: reason.id, reasonName: reason.name, note: lossNote.trim(),
    }]);
    setLossProduct(null); setLossQuery(''); setLossQty('1'); setLossNote(''); setLossReasonId(null);
  }

  function removeLossItem(id: string) {
    setLossItems(prev => prev.filter(i => i.id !== id));
  }

  // Sends every item in lossItems — sequentially (not Promise.all) so a slow/failing Odoo call
  // for one item never races with another and the per-item ok/error count stays accurate.
  async function submitLoss() {
    const trimmedName = lossName.trim();
    if (!trimmedName || lossItems.length === 0) return;
    try { localStorage.setItem(LOSS_NAME_STORAGE_KEY, trimmedName); } catch {}
    setLossSubmitting(true); setLossMsg(null);
    const { recordShopLossAction } = await import('./actions');
    let okCount = 0, errCount = 0, syncErrCount = 0;
    for (const item of lossItems) {
      const res = await recordShopLossAction({
        sku: item.product.sku, productName: item.product.name_vi, qty: item.qty,
        reasonTagId: item.reasonId, reasonTagName: item.reasonName,
        note: item.note || null, reportedByName: trimmedName,
        ...(readOnly ? { shopName } : {}),
      });
      if (res.error) errCount++;
      else { okCount++; if (!res.odooSynced) syncErrCount++; }
    }
    setLossSubmitting(false);
    if (errCount > 0) setLossMsg(`Đã lưu ${okCount}/${lossItems.length} sản phẩm, ${errCount} lỗi`);
    else if (syncErrCount > 0) setLossMsg(`Đã lưu ${okCount} sản phẩm (${syncErrCount} chưa đồng bộ Odoo)`);
    else setLossMsg(`Đã lưu và đồng bộ Odoo (${okCount} sản phẩm)`);
    setLossItems([]);
    setLosses(null);
    loadLosses();
  }

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

  // Opens the confirm sheet with a snapshot of the current draft — does NOT save anything yet.
  function requestConfirmLine(order: ShopDeliveryOrder, l: ShopDeliveryOrder['lines'][number]) {
    const d = draft[l.id];
    if (!d || !name.trim()) return;
    const qtyNum = d.qty.trim() === '' ? null : Number(d.qty);
    setPendingReceipt({ order, line: l, qty: qtyNum, note: d.note });
  }

  // The actual write — only ever called from the confirm sheet's "Xác nhận" button.
  async function doSubmitLine(order: ShopDeliveryOrder, l: ShopDeliveryOrder['lines'][number], qtyNum: number | null, note: string) {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    try { localStorage.setItem(NAME_STORAGE_KEY, trimmedName); } catch {}
    const status: 'ok' | 'issue' = qtyNum === null || qtyNum !== refQty(l) ? 'issue' : 'ok';
    setSaving(l.id);
    const { confirmReceiptAction } = await import('./actions');
    const res = await confirmReceiptAction({
      checkLineId: l.id, deliveryOrderId: order.header.id,
      qtyReceived: qtyNum, status, note: note.trim() || null,
      confirmedByName: trimmedName,
      ...(readOnly ? { shopName } : {}),
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
  // this only needs to check which tab is active. Staff-test access (readOnly=true) is now just
  // as interactive as the shop's own login (Axel, 2026-08-25) — the only remaining gate is the day.
  const canConfirm = day === 'today';

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FAF8F3' }}>
      <div className="px-4 py-4 sm:px-6" style={{ backgroundColor: '#1f2937' }}>
        <div className="max-w-xl mx-auto flex items-center justify-between">
          <div>
            <div className="text-white/60 text-xs font-semibold uppercase tracking-widest">La Parisienne Lab{readOnly ? ' · Chế độ Admin' : ''}</div>
            <h1 className="text-white font-serif text-xl font-bold">{shopName}</h1>
          </div>
          {readOnly ? (
            <button onClick={() => router.push('/admin/shop-access')}
              className="inline-flex items-center gap-1.5 p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 text-xs font-semibold" aria-label="Quay lại admin">
              <ArrowLeft size={16} /> Admin
            </button>
          ) : (
            <button onClick={logout} className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10" aria-label="Đăng xuất">
              <LogOut size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-4 space-y-4">
        {readOnly && (
          <div className="rounded-xl px-3.5 py-2.5 flex items-start gap-2" style={{ backgroundColor: '#FEF3C7', border: '1px solid #FCD34D' }}>
            <AlertTriangle size={15} className="mt-0.5 shrink-0" style={{ color: '#92400E' }} />
            <div className="text-xs" style={{ color: '#92400E' }}>
              <span className="font-bold">Chế độ Admin — thao tác thay cho {shopName}.</span> Mọi xác nhận/báo cáo hao hụt ở đây được ghi thật (kể cả gửi lên Odoo), giống hệt như boutique tự làm.
            </div>
          </div>
        )}
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
          <button onClick={() => setTab('losses')}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'losses' ? '#1f2937' : 'white', color: tab === 'losses' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Trash2 size={16} /> Hao hụt
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
              {day === 'today' && (
                <div className="bg-white rounded-2xl px-4 py-2.5 flex items-center gap-2" style={{ border: '1px solid #E5E7EB' }}>
                  <span className="text-xs font-semibold shrink-0" style={{ color: '#6B7280' }}>Xác nhận bởi</span>
                  <NamePicker value={name} onChange={setName} names={staffNames} onManage={() => setShowStaffModal(true)} />
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
                          <div className="min-w-0 flex-1 flex items-center gap-2.5">
                            {l.image_url && (
                              <button type="button" onClick={() => setZoomImage(l.image_url)}
                                className="shrink-0 w-11 h-11 rounded-lg overflow-hidden" style={{ border: '1px solid #E5E7EB' }}
                                aria-label="Xem ảnh sản phẩm">
                                <img src={l.image_url} alt="" className="w-full h-full object-cover" />
                              </button>
                            )}
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-navy truncate">{l.product_name_vi}</div>
                            </div>
                          </div>
                          {/* 3 explicit columns (Axel, 2026-08-27): what the client originally
                              ordered, what the assistant physically checked in the lab (the
                              shop's real reference point for a diff, not the original order qty),
                              and what the shop itself received/confirms — kept as 3 separate
                              labeled stats instead of qty_expected being a buried subtext, so
                              none of the 3 numbers get mistaken for another. */}
                          <div className="flex items-center gap-2.5 shrink-0">
                            <div className="text-center">
                              <div className="text-[9px] uppercase font-bold tracking-wide" style={{ color: '#9CA3AF' }}>Đặt</div>
                              <div className="text-sm font-bold" style={{ color: '#9CA3AF' }}>×{l.qty_expected}</div>
                            </div>
                            <div className="text-center">
                              <div className="text-[9px] uppercase font-bold tracking-wide" style={{ color: '#9CA3AF' }}>Bếp</div>
                              <div className="text-sm font-bold" style={{ color: l.qty_checked != null ? '#1f2937' : '#D1D5DB' }}>
                                {l.qty_checked != null ? `×${l.qty_checked}` : '—'}
                              </div>
                            </div>
                            <div className="text-center">
                              <div className="text-[9px] uppercase font-bold tracking-wide" style={{ color: '#9CA3AF' }}>Nhận</div>
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
                                  <button onClick={() => requestConfirmLine(o, l)} disabled={saving === l.id || !name.trim()}
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
        ) : tab === 'losses' ? (
          <div className="space-y-3">
            {(
              <div className="bg-white rounded-2xl p-4 space-y-2.5" style={{ border: '1px solid #E5E7EB' }}>
                <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Báo cáo hao hụt</div>
                <div>
                  <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Tên của bạn</div>
                  <NamePicker value={lossName} onChange={setLossName} names={staffNames} onManage={() => setShowStaffModal(true)} />
                </div>
                <div className="relative">
                  <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Sản phẩm</div>
                  {lossProduct ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB', backgroundColor: '#F9FAFB' }}>
                      <span className="flex items-center gap-2 min-w-0">
                        {lossProduct.main_image_url && (
                          <button type="button" onClick={() => setZoomImage(lossProduct.main_image_url!)}
                            className="shrink-0 w-8 h-8 rounded overflow-hidden" aria-label="Xem ảnh sản phẩm">
                            <img src={lossProduct.main_image_url} alt="" className="w-full h-full object-cover" />
                          </button>
                        )}
                        <span className="font-semibold truncate">{lossProduct.name_vi}{lossProduct.sku ? ` (${lossProduct.sku})` : ''}</span>
                      </span>
                      <button onClick={() => { setLossProduct(null); setLossQuery(''); }} className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>Đổi</button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
                      <input type="text" value={lossQuery} onChange={e => setLossQuery(e.target.value)}
                        placeholder="Tìm sản phẩm…" className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                      {lossQuery.trim().length >= 2 && (
                        <div className="mt-1 rounded-lg overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                          {lossSearching ? (
                            <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Đang tìm…</div>
                          ) : !lossResults.length ? (
                            <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Không tìm thấy</div>
                          ) : lossResults.slice(0, 8).map(p => (
                            <button key={p.id} onClick={() => { setLossProduct(p); setLossResults([]); }}
                              className="w-full text-left px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2" style={{ borderColor: '#F3F4F6' }}>
                              {p.main_image_url && <img src={p.main_image_url} alt="" className="w-8 h-8 rounded object-cover shrink-0" />}
                              <span className="truncate">{p.name_vi}{p.sku ? <span style={{ color: '#9CA3AF' }}> · {p.sku}</span> : null}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex gap-2.5">
                  <div className="flex-1">
                    <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Số lượng</div>
                    <input type="number" min={0} step="1" value={lossQty} onChange={e => setLossQty(e.target.value)}
                      className="w-full rounded-lg px-2.5 py-1.5 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
                  </div>
                  <div className="flex-[2]">
                    <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Lý do</div>
                    <select value={lossReasonId ?? ''} onChange={e => setLossReasonId(e.target.value ? Number(e.target.value) : null)}
                      className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }}>
                      <option value="">Chọn lý do…</option>
                      {(lossReasons ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                </div>
                <input type="text" value={lossNote} onChange={e => setLossNote(e.target.value)}
                  placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                <button onClick={addLossItem}
                  disabled={!lossProduct || !lossReasonId || !(Number(lossQty) > 0)}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 disabled:opacity-40"
                  style={{ backgroundColor: '#F3F4F6', color: '#1f2937', border: '1px solid #D1D5DB' }}>
                  + Thêm vào danh sách
                </button>

                {lossItems.length > 0 && (
                  <div className="space-y-1.5 pt-1" style={{ borderTop: '1px solid #F3F4F6' }}>
                    <div className="text-xs font-bold uppercase tracking-wide pt-1.5" style={{ color: '#6B7280' }}>
                      Danh sách ({lossItems.length})
                    </div>
                    {lossItems.map(item => (
                      <div key={item.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#F9FAFB', border: '1px solid #F3F4F6' }}>
                        {item.product.main_image_url && (
                          <img src={item.product.main_image_url} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold truncate">{item.product.name_vi} <span style={{ color: '#9CA3AF', fontWeight: 400 }}>×{item.qty}</span></div>
                          <div className="text-[11px] truncate" style={{ color: '#9CA3AF' }}>{item.reasonName}{item.note ? ` · ${item.note}` : ''}</div>
                        </div>
                        <button onClick={() => removeLossItem(item.id)} className="text-xs font-bold shrink-0 px-1" style={{ color: '#DC2626' }} aria-label="Xoá">✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Bug found 2026-08-27 (Axel: "je voulais faire un test de perte produit mais pas
                    possible") — this button stayed disabled whenever lossItems was still empty,
                    which is exactly the state right after filling product/qty/reason but before
                    tapping "+ Thêm vào danh sách": nothing on screen explained why the button
                    wouldn't light up. It now folds the currently-filled picker into the list for
                    you on tap (same as pressing "+ Thêm vào danh sách" first) when there's
                    something valid to add — the explicit add-to-list button is still there for
                    the multi-product case, this just stops a single-product report from silently
                    requiring an extra, unexplained tap. */}
                <button onClick={() => { if (lossItems.length === 0) addLossItem(); setPendingLoss(true); }}
                  disabled={lossSubmitting || !lossName.trim() || (lossItems.length === 0 && !(lossProduct && lossReasonId && Number(lossQty) > 0))}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 text-white disabled:opacity-40"
                  style={{ backgroundColor: '#DC2626' }}>
                  {lossSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  {lossItems.length > 1 ? `Báo cáo hao hụt (${lossItems.length} sản phẩm)` : 'Báo cáo hao hụt'}
                </button>
                {lossName.trim() && lossProduct && lossReasonId && Number(lossQty) > 0 && lossItems.length === 0 && (
                  <div className="text-[11px]" style={{ color: '#9CA3AF' }}>
                    Sẵn sàng báo cáo — hoặc nhấn "+ Thêm vào danh sách" để thêm sản phẩm khác trước.
                  </div>
                )}
                {lossMsg && <div className="text-xs font-semibold" style={{ color: lossMsg.startsWith('Lỗi') || lossMsg.includes('lỗi') ? '#DC2626' : '#059669' }}>{lossMsg}</div>}
              </div>
            )}
            {lossesLoading && losses === null ? (
              <div className="text-center py-6 text-sm" style={{ color: '#6B7280' }}>Đang tải…</div>
            ) : !losses?.length ? (
              <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
                Chưa có báo cáo hao hụt nào
              </div>
            ) : (
              <div className="space-y-2">
                {losses.map(l => (
                  <div key={l.id} className="bg-white rounded-2xl p-3.5" style={{ border: '1px solid #E5E7EB' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-bold text-navy truncate">{l.productName} ×{l.qty}</div>
                      {l.odooScrapId ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold shrink-0" style={{ color: '#059669' }}><CheckCircle2 size={12} /> Odoo</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold shrink-0" style={{ color: '#D97706' }}><AlertTriangle size={12} /> Chưa đồng bộ</span>
                      )}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#6B7280' }}>{l.reasonTagName}{l.note ? ` · ${l.note}` : ''}</div>
                    <div className="text-[11px] mt-1" style={{ color: '#9CA3AF' }}>{l.reportedByName} · {new Date(l.reportedAt).toLocaleString('vi-VN')}</div>
                  </div>
                ))}
              </div>
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

      {/* Full-screen photo viewer — tap any thumbnail (receipt line or scrap picker) to open. */}
      {zoomImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
          onClick={() => setZoomImage(null)}>
          <img src={zoomImage} alt="" className="max-w-full max-h-full rounded-xl" onClick={e => e.stopPropagation()} />
        </div>
      )}

      {/* Double-check before confirming a receipt — nothing is saved until "Xác nhận" here. */}
      {pendingReceipt && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Xác nhận nhận hàng</div>
            <div className="flex items-center gap-3">
              {pendingReceipt.line.image_url && (
                <img src={pendingReceipt.line.image_url} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E5E7EB' }} />
              )}
              <div className="min-w-0">
                <div className="text-sm font-bold text-navy truncate">{pendingReceipt.line.product_name_vi}</div>
                <div className="text-xs" style={{ color: '#9CA3AF' }}>Đơn {pendingReceipt.order.header.order_ref}</div>
              </div>
            </div>
            <div className="rounded-xl p-3 space-y-1.5" style={{ backgroundColor: '#F9FAFB' }}>
              <div className="flex items-center justify-between text-sm">
                <span style={{ color: '#6B7280' }}>Bếp giao</span>
                <span className="font-bold">×{refQty(pendingReceipt.line)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span style={{ color: '#6B7280' }}>Bạn xác nhận</span>
                <span className="font-bold" style={{ color: pendingReceipt.qty !== refQty(pendingReceipt.line) ? '#DC2626' : '#1f2937' }}>
                  {pendingReceipt.qty === null ? '—' : `×${pendingReceipt.qty}`}
                </span>
              </div>
              {pendingReceipt.note.trim() && (
                <div className="text-xs pt-1" style={{ color: '#6B7280' }}>Ghi chú: {pendingReceipt.note.trim()}</div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPendingReceipt(null)}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                Huỷ
              </button>
              <button
                onClick={() => { const p = pendingReceipt; setPendingReceipt(null); if (p) doSubmitLine(p.order, p.line, p.qty, p.note); }}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: '#16A34A' }}>
                Xác nhận
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Double-check before a scrap report — this one goes straight to Odoo (stock.scrap per
          item), so nothing fires until "Xác nhận" here (Axel, 2026-08-25). Lists every item
          added to the batch, not just one product (Axel, 2026-08-25: "scrap plusieurs produit
          et non un par 1"). */}
      {pendingLoss && lossItems.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
              Xác nhận báo cáo hao hụt ({lossItems.length} sản phẩm)
            </div>
            <div className="space-y-1.5">
              {lossItems.map(item => (
                <div key={item.id} className="flex items-center gap-3 rounded-xl p-2.5" style={{ backgroundColor: '#FEF2F2' }}>
                  {item.product.main_image_url && (
                    <img src={item.product.main_image_url} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0" style={{ border: '1px solid #FCA5A5' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-navy truncate">{item.product.name_vi}{item.product.sku ? ` (${item.product.sku})` : ''}</div>
                    <div className="text-xs" style={{ color: '#6B7280' }}>{item.reasonName}{item.note ? ` · ${item.note}` : ''}</div>
                  </div>
                  <span className="text-sm font-bold shrink-0" style={{ color: '#DC2626' }}>×{item.qty}</span>
                </div>
              ))}
            </div>
            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>Thao tác này gửi thẳng lên Odoo và không thể huỷ.</div>
            <div className="flex gap-2">
              <button onClick={() => setPendingLoss(false)}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                Huỷ
              </button>
              <button onClick={() => { setPendingLoss(false); submitLoss(); }}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: '#DC2626' }}>
                Xác nhận
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manage staff roster — reachable from the gear button next to either name picker
          (Axel, 2026-08-27). Add / rename / delete; shared by both usages since it's one
          roster per shop. */}
      {showStaffModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => setShowStaffModal(false)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Danh sách nhân viên</div>
            <div className="flex items-center gap-1.5">
              <input type="text" value={newStaffInput} onChange={e => setNewStaffInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addStaffName(); }}
                placeholder="Tên nhân viên mới…" className="flex-1 rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              <button onClick={addStaffName} disabled={staffBusy === 'add' || !newStaffInput.trim()}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-white shrink-0 disabled:opacity-40"
                style={{ backgroundColor: '#16A34A' }} aria-label="Thêm">
                {staffBusy === 'add' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={16} />}
              </button>
            </div>
            <div className="space-y-1.5">
              {!staffNames?.length ? (
                <div className="text-xs text-center py-3" style={{ color: '#9CA3AF' }}>Chưa có nhân viên nào</div>
              ) : staffNames.map(s => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#F9FAFB', border: '1px solid #F3F4F6' }}>
                  {editingStaffId === s.id ? (
                    <>
                      <input type="text" value={editStaffDraft} onChange={e => setEditStaffDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveStaffRename(s.id); }} autoFocus
                        className="flex-1 min-w-0 rounded-lg px-2 py-1 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                      <button onClick={() => saveStaffRename(s.id)} disabled={staffBusy === s.id || !editStaffDraft.trim()}
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-white shrink-0 disabled:opacity-40"
                        style={{ backgroundColor: '#16A34A' }} aria-label="Lưu">
                        {staffBusy === s.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
                      </button>
                      <button onClick={() => setEditingStaffId(null)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg shrink-0" style={{ border: '1px solid #D1D5DB' }} aria-label="Huỷ">
                        <X size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 text-sm font-medium truncate">{s.name}</span>
                      <button onClick={() => { setEditingStaffId(s.id); setEditStaffDraft(s.name); }}
                        className="w-7 h-7 flex items-center justify-center rounded-lg shrink-0" style={{ border: '1px solid #D1D5DB' }}
                        aria-label="Sửa" title="Sửa">
                        <Pencil size={12} />
                      </button>
                      <button onClick={() => deleteStaffName(s.id)} disabled={staffBusy === s.id}
                        className="w-7 h-7 flex items-center justify-center rounded-lg shrink-0 disabled:opacity-40"
                        style={{ border: '1px solid #FCA5A5', color: '#DC2626' }} aria-label="Xoá" title="Xoá">
                        {staffBusy === s.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <button onClick={() => setShowStaffModal(false)}
              className="w-full text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
              Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
