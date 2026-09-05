'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, Cake, Trash2, CheckCircle2, AlertTriangle, Clock, Loader2, LogOut, User, Phone, MapPin, StickyNote, Pencil, Search, ArrowLeft, Settings, Plus, Minus, X, Check, ClipboardList, FileText, Download, Package2, Send } from 'lucide-react';
import type { ShopDeliveryOrder, ShopCake, ShopLoss, ShopLossReason, ShopStaffName, ShopLossDailyRecap, ShopStockCountLine, ShopStockSearchProduct, ShopStockCountSession, ShopDailyReport, ShopManager, ShopManagerCatalogProduct, ShopManagerOrderDraft } from './actions';
import type { CheckLine } from '@/lib/delivery-check';
import { thumb } from '@/lib/img-thumb';

const LOSS_NAME_STORAGE_KEY = 'lab_shop_loss_name';
const STOCK_NAME_STORAGE_KEY = 'lab_shop_stock_name';

// Same result shape as /api/lab/products-search (station/inventory product picker) — reused
// as-is here rather than writing a second search endpoint. main_image_url is already returned
// by that route (dv?.image_url ?? f.image_url) — kept here too so the scrap picker can show a
// thumbnail (helps confirm the right product before an Odoo-bound report, 2026-08-25).
type ProductVariantOption = { id: string; sku: string | null; label: string; image_url: string | null };
type ProductSearchResult = {
  id: string; name_vi: string; name_en: string | null; sku: string | null; main_image_url?: string | null;
  variants?: ProductVariantOption[];
};
// Flattened, selectable row for the loss-report picker: one fiche can have several variants
// (flavor/size), and each needs its own SKU picked explicitly — Axel, 2026-08-29: "ils voient
// pas les variantes". Before this, the dropdown only ever showed/used the fiche's default
// variant sku, so a shop reporting a loss of a non-default flavor/size silently scrapped the
// wrong SKU in Odoo (or, for fiches without a default, an arbitrary one).
type LossPickOption = ProductSearchResult & { variantLabel: string | null };

function flattenForPicker(results: ProductSearchResult[]): LossPickOption[] {
  const out: LossPickOption[] = [];
  for (const p of results) {
    const variants = p.variants ?? [];
    if (variants.length <= 1) {
      out.push({ ...p, variantLabel: null });
      continue;
    }
    for (const v of variants) {
      out.push({
        id: `${p.id}:${v.id}`,
        name_vi: p.name_vi,
        name_en: p.name_en,
        sku: v.sku,
        main_image_url: v.image_url ?? p.main_image_url ?? null,
        variantLabel: v.label && v.label !== 'Standard' ? v.label : null,
      });
    }
  }
  return out;
}

const NAME_STORAGE_KEY = 'lab_shop_confirm_name';

function fmtDate(d: string) {
  const [y, m, day] = d.split('-');
  return `${day}/${m}`;
}

// Kiểm kho is grouped by fiche category (Axel, 2026-09-03: "je veux un comptage par category").
// The list already arrives sorted category-then-name from the server, so this just buckets it —
// insertion order into the Map already matches that server order, no re-sort needed here.
function groupStockByCategory(lines: ShopStockCountLine[]): { category: string; lines: ShopStockCountLine[] }[] {
  const byCategory = new Map<string, ShopStockCountLine[]>();
  for (const l of lines) {
    if (!byCategory.has(l.category)) byCategory.set(l.category, []);
    byCategory.get(l.category)!.push(l);
  }
  return Array.from(byCategory.entries()).map(([category, lines]) => ({ category, lines }));
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
  const [tab, setTab] = useState<'deliveries' | 'cakes' | 'losses' | 'stock' | 'report' | 'order'>('deliveries');
  const [orders, setOrders] = useState<ShopDeliveryOrder[] | null>(null);
  const [cakes, setCakes] = useState<ShopCake[] | null>(null);
  // ── Pertes (daily loss/scrap) — loaded lazily, only when the tab is first opened, so
  // read-only staff previews and the deliveries/cakes tabs never pay for it.
  const [losses, setLosses] = useState<ShopLoss[] | null>(null);
  const [dailyRecap, setDailyRecap] = useState<ShopLossDailyRecap[] | null>(null);
  const [lossReasons, setLossReasons] = useState<ShopLossReason[] | null>(null);
  const [lossesLoading, setLossesLoading] = useState(false);
  const [lossQuery, setLossQuery] = useState('');
  const [lossResults, setLossResults] = useState<ProductSearchResult[]>([]);
  const [lossSearching, setLossSearching] = useState(false);
  const [lossProduct, setLossProduct] = useState<LossPickOption | null>(null);
  const [lossQty, setLossQty] = useState('1');
  const [lossReasonId, setLossReasonId] = useState<number | null>(null);
  const [lossNote, setLossNote] = useState('');
  // Multiple products per report (Axel, 2026-08-25: "la possibilite de scrap plusieurs produit
  // et non un par 1") — each "Thêm vào danh sách" tap snapshots the current product/qty/reason/
  // note into this list and resets the picker for the next item; the actual submit sends every
  // item in the list in one go, each still becoming its own lab_shop_losses row + stock.scrap
  // (Odoo has no native "scrap several products at once" endpoint).
  const [lossItems, setLossItems] = useState<{ id: string; product: LossPickOption; qty: number; reasonId: number; reasonName: string; note: string }[]>([]);
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

  // ── Kiểm kho (daily stock count) — Axel, 2026-09-03: shops count their own stock every day,
  // in-app only, no Odoo write for now. The checklist (which SKUs) is auto-built server-side
  // from this shop's own order history (rolling 2-week window) + any manually-added extras;
  // quantities are never prefilled — only what the shop already saved today (if reopening).
  const [stockLines, setStockLines] = useState<ShopStockCountLine[] | null>(null);
  const [stockDate, setStockDate] = useState<string | null>(null);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockDraft, setStockDraft] = useState<Record<string, string>>({});
  const [stockName, setStockName] = useState('');
  const [stockSaving, setStockSaving] = useState(false);
  const [stockMsg, setStockMsg] = useState<string | null>(null);
  const [stockSearchQuery, setStockSearchQuery] = useState('');
  const [stockSearchResults, setStockSearchResults] = useState<ShopStockSearchProduct[]>([]);
  const [stockSearching, setStockSearching] = useState(false);
  const [stockCategoryFilter, setStockCategoryFilter] = useState<string | null>(null);
  // Axel, 2026-09-05: "plusieurs inventaire par jour" — session_seq lets a shop run several
  // distinct counts in one day. stockSessionSeq is whichever session is currently shown (usually
  // the latest/editable one); stockLatestSessionSeq is the actual latest saved session, used to
  // tell whether stockSessionSeq is viewing history (< latest) or is the live one (== latest).
  const [stockSessionSeq, setStockSessionSeq] = useState(1);
  const [stockLatestSessionSeq, setStockLatestSessionSeq] = useState(1);
  const [stockSessions, setStockSessions] = useState<ShopStockCountSession[]>([]);
  const [stockNewSessionConfirm, setStockNewSessionConfirm] = useState(false);

  // Daily report ("Báo cáo") — Axel, 2026-09-03 phase 2: combines today's stock count + today's
  // losses, generated on demand (re-fetched every time this tab is opened, unlike the other tabs'
  // load-once-per-mount caches, since it depends on data the shop may have just changed on the
  // Kiểm kho tab).
  const [dailyReport, setDailyReport] = useState<ShopDailyReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportExporting, setReportExporting] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);

  // Đặt hàng — Axel, 2026-09-03 phase 3, revised 2026-09-05: ANY shop staff member can build the
  // cart (no PIN, identified via NamePicker like Kiểm kho/Hao hụt) — a manager's PIN is only
  // needed at the very last step, to actually confirm and send the order to Odoo (or, if nobody
  // does before 14h00 for a delivery of tomorrow, the scheduled job sends it on their behalf).
  // The cart/date/time double as a shared draft persisted to lab_shop_manager_order_drafts —
  // saved explicitly ("Lưu nháp") or implicitly the moment someone taps "Xác nhận đơn hàng", so
  // work is never lost even if the PIN step is cancelled.
  const [orderCreatedByName, setOrderCreatedByName] = useState('');
  const [orderDeliveryDate, setOrderDeliveryDate] = useState<string | null>(null);
  const [orderDeliveryTime, setOrderDeliveryTime] = useState('09:00');
  const [orderMinDate, setOrderMinDate] = useState<string | null>(null);
  const [orderTomorrowOpen, setOrderTomorrowOpen] = useState(true);
  const [orderCategories, setOrderCategories] = useState<string[]>([]);
  const [orderCategoryFilter, setOrderCategoryFilter] = useState<string | null>(null);
  const [orderSearchQuery, setOrderSearchQuery] = useState('');
  const [orderSearchResults, setOrderSearchResults] = useState<ShopManagerCatalogProduct[]>([]);
  const [orderSearching, setOrderSearching] = useState(false);
  const [orderCart, setOrderCart] = useState<{ sku: string; name: string; qty: number; note: string; imageUrl: string | null }[]>([]);
  const [orderDraftLoaded, setOrderDraftLoaded] = useState<ShopManagerOrderDraft | null>(null);
  const [orderDraftSaving, setOrderDraftSaving] = useState(false);
  const [orderPendingConfirm, setOrderPendingConfirm] = useState(false);
  const [orderConfirmPin, setOrderConfirmPin] = useState('');
  const [orderConfirmMsg, setOrderConfirmMsg] = useState<string | null>(null);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderMsg, setOrderMsg] = useState<string | null>(null);
  const [orderResult, setOrderResult] = useState<{ orderRef: string; deliveryDate: string; deliveryTime?: string; managerName?: string } | null>(null);

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
      try { setStockName(localStorage.getItem(STOCK_NAME_STORAGE_KEY) ?? ''); } catch {}
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

  useEffect(() => {
    if (tab !== 'stock' || stockLines !== null) return;
    loadStock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== 'report') return;
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== 'order' || orderMinDate) return;
    (async () => {
      const actions = await import('./actions');
      const res = await actions.getManagerOrderContextAction();
      setOrderMinDate(res.minDate ?? null);
      setOrderTomorrowOpen(res.tomorrowOrderingOpen ?? true);
      setOrderDeliveryDate(res.defaultDate ?? res.minDate ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== 'order' || orderCategories.length) return;
    (async () => {
      const actions = await import('./actions');
      const res = await actions.getManagerOrderCategoriesAction(readOnly ? shopName : undefined);
      setOrderCategories(res.categories ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Loads whatever draft already exists for the currently-selected delivery date — any staff or
  // manager picks up exactly where the last person left off, on any device, under the shared
  // shop login (Axel, 2026-09-05).
  useEffect(() => {
    if (tab !== 'order' || !orderDeliveryDate) return;
    (async () => {
      const actions = await import('./actions');
      const res = await actions.getManagerOrderDraftAction(orderDeliveryDate, readOnly ? shopName : undefined);
      if (res.error) return;
      const draft = res.draft ?? null;
      setOrderDraftLoaded(draft);
      if (draft) {
        setOrderCart(draft.lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note ?? '', imageUrl: null })));
        if (draft.deliveryTime) setOrderDeliveryTime(draft.deliveryTime);
        if (draft.createdByName) setOrderCreatedByName(draft.createdByName);
      } else {
        setOrderCart([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, orderDeliveryDate]);

  useEffect(() => {
    const q = orderSearchQuery.trim();
    if (q.length < 2 && !orderCategoryFilter) { setOrderSearchResults([]); return; }
    const t = setTimeout(async () => {
      setOrderSearching(true);
      const actions = await import('./actions');
      const res = await actions.searchManagerOrderProductsAction(q, readOnly ? shopName : undefined, orderCategoryFilter ?? undefined);
      setOrderSearching(false);
      setOrderSearchResults(res.products ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [orderSearchQuery, orderCategoryFilter]);

  useEffect(() => {
    const q = stockSearchQuery.trim();
    if (q.length < 2) { setStockSearchResults([]); return; }
    const t = setTimeout(async () => {
      setStockSearching(true);
      const actions = await import('./actions');
      const res = await actions.searchStockCountProductsAction(q, readOnly ? shopName : undefined);
      setStockSearching(false);
      setStockSearchResults(res.products ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [stockSearchQuery]);

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
    const recapRes = readOnly ? await actions.getShopLossesDailyRecapForStaffAction(shopName) : await actions.getMyShopLossesDailyRecapAction();
    if (recapRes.recap) setDailyRecap(recapRes.recap);
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
        sku: item.product.sku,
        productName: item.product.variantLabel ? `${item.product.name_vi} — ${item.product.variantLabel}` : item.product.name_vi,
        qty: item.qty,
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

  // `silent` (Axel, 2026-08-29: shop staff report "everytime we click ok its loaded again")
  // skips the `loading` flag entirely. The whole tab body — including whichever order a shop
  // is mid-way through checking off line by line — is gated behind `{loading ? <Đang tải…> :
  // ...}` below, so every single-line confirm (which calls load() to pick up the freshly-
  // checked qty) was blanking the ENTIRE screen back to a bare loading state and only
  // reappearing once the refetch resolved — jarring on every tap, and worse on a slow connection
  // (exactly what a shop tablet on wifi would see). The initial mount load (useEffect below)
  // still wants the real spinner, since there's nothing to show yet.
  async function load(opts?: { silent?: boolean }) {
    if (!opts?.silent) setLoading(true);
    setError(null);
    const actions = await import('./actions');
    const [delRes, cakeRes] = await Promise.all([
      readOnly ? actions.getShopDeliveriesForStaffAction(shopName) : actions.getMyShopDeliveriesAction(),
      readOnly ? actions.getShopCakesForStaffAction(shopName) : actions.getMyShopCakesAction(),
    ]);
    if (!opts?.silent) setLoading(false);
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
    // The qty input DISPLAYS a computed default (saved receipt qty, else the lab-checked qty)
    // even when the shop never touched the field -- but that default only lands in `draft` on a
    // keystroke or a pencil tap. OK then found no draft entry and silently did nothing (shops,
    // 2026-09-01: "you have to put some number in the receive field before clicking OK,
    // although there are numbers in there already"). Confirm exactly what the input displays --
    // the same fallback expression the render uses -- instead of requiring a keystroke first.
    const d = draft[l.id] ?? { qty: String(l.receipt?.qty_received ?? refQty(l)), note: l.receipt?.note ?? '' };
    if (!name.trim()) return;
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
    if (res.ok) { setEditing(p => { const n = new Set(p); n.delete(l.id); return n; }); load({ silent: true }); }
  }

  // viewSessionSeq lets the caller ask for a specific session (used to preview a brand-new
  // blank one, or to look back at an earlier one in history) — omitted, it loads whichever is
  // the shop's current/latest session of the day.
  async function loadStock(viewSessionSeq?: number) {
    setStockLoading(true);
    const actions = await import('./actions');
    const res = readOnly ? await actions.getStockCountListForStaffAction(shopName, viewSessionSeq) : await actions.getMyStockCountListAction(viewSessionSeq);
    setStockLoading(false);
    if (res.error) { setStockMsg(`Lỗi: ${res.error}`); return; }
    setStockLines(res.lines ?? []);
    setStockDate(res.date ?? null);
    setStockSessionSeq(res.sessionSeq ?? 1);
    setStockLatestSessionSeq(res.latestSessionSeq ?? 1);
    setStockSessions(res.sessions ?? []);
    const d: Record<string, string> = {};
    for (const l of res.lines ?? []) if (l.qty !== null) d[l.sku] = String(l.qty);
    setStockDraft(d);
  }

  // "Nouveau comptage" (Axel, 2026-09-05) — previews the next session number as a blank
  // checklist. Nothing is persisted until the shop actually taps "Lưu kiểm kho": if they close
  // the tab before saving, the next visit just falls back to the real latest session again.
  function startNewStockSession() {
    setStockNewSessionConfirm(false);
    loadStock(stockLatestSessionSeq + 1);
    setStockMsg(null);
  }

  async function addStockItem(p: ShopStockSearchProduct) {
    const trimmedName = stockName.trim();
    if (!trimmedName) { setStockMsg('Chọn tên trước khi thêm sản phẩm'); return; }
    const actions = await import('./actions');
    const res = await actions.addStockCountItemAction({
      sku: p.sku, name: p.name, addedByName: trimmedName, ...(readOnly ? { shopName } : {}),
    });
    if (res.item) {
      setStockLines(prev => {
        const cur = prev ?? [];
        if (cur.some(l => l.sku === res.item!.sku)) return cur;
        return [...cur, res.item!].sort((a, b) => a.name.localeCompare(b.name));
      });
      setStockSearchQuery(''); setStockSearchResults([]); setStockMsg(null);
    } else if (res.error) setStockMsg(`Lỗi: ${res.error}`);
  }

  // Sends only the rows the shop actually typed a quantity for — a blank input is simply not
  // included, never coerced to 0 (Axel: comptage NOT prefilled). Re-savable any number of times
  // within the current session (server upserts on shop_name+sku+count_date+session_seq) —
  // "Đợt mới" above is what actually starts a distinct new count.
  async function saveStockCount() {
    const trimmedName = stockName.trim();
    if (!trimmedName || !stockLines?.length) return;
    const validSkus = new Set(stockLines.map(l => l.sku));
    const entries = Object.entries(stockDraft)
      .filter(([sku, v]) => validSkus.has(sku) && v.trim() !== '')
      .map(([sku, v]) => ({ sku, qty: Number(v) }))
      .filter(e => Number.isFinite(e.qty) && e.qty >= 0);
    if (!entries.length) { setStockMsg('Chưa nhập số lượng nào'); return; }
    try { localStorage.setItem(STOCK_NAME_STORAGE_KEY, trimmedName); } catch {}
    setStockSaving(true); setStockMsg(null);
    const actions = await import('./actions');
    const res = await actions.saveStockCountAction({
      entries, updatedByName: trimmedName, sessionSeq: stockSessionSeq, ...(readOnly ? { shopName } : {}),
    });
    setStockSaving(false);
    if (res.error) { setStockMsg(`Lỗi: ${res.error}`); return; }
    setStockMsg(`Đã lưu ${res.saved} sản phẩm`);
    if (res.sessionSeq) setStockSessionSeq(res.sessionSeq);
    setStockLatestSessionSeq(prev => Math.max(prev, res.sessionSeq ?? prev));
    setStockSessions(prev => {
      const seq = res.sessionSeq ?? stockSessionSeq;
      const now = new Date().toISOString();
      const existing = prev.find(s => s.seq === seq);
      if (existing) return prev.map(s => s.seq === seq ? { ...s, savedCount: res.saved ?? s.savedCount, updatedAt: now, updatedByNames: Array.from(new Set([...s.updatedByNames, trimmedName])) } : s);
      return [...prev, { seq, savedCount: res.saved ?? 0, updatedAt: now, updatedByNames: [trimmedName] }].sort((a, b) => a.seq - b.seq);
    });
  }

  async function loadReport() {
    setReportLoading(true);
    setReportMsg(null);
    const actions = await import('./actions');
    const res = readOnly ? await actions.getDailyReportForStaffAction(shopName) : await actions.getMyDailyReportAction();
    setReportLoading(false);
    if (res.error) { setReportMsg(`Lỗi: ${res.error}`); return; }
    setDailyReport(res.report ?? null);
  }

  // Client-side PDF export (Axel, 2026-09-03: "le rapport doit etre exportable pdf" — "pdf en
  // viet bien sur") — rasterizes the already-rendered report DOM (real browser text layout, so
  // Draws the report as real vector text — not a screenshot — using jsPDF's own text/shape APIs,
  // so the PDF is sharp at any zoom, has selectable/searchable text, and stays small. Vietnamese
  // diacritics need a font that actually has those glyphs (jsPDF's built-in fonts don't), so a
  // Noto Sans subset carrying every character used in the catalog is embedded from
  // src/lib/pdf-fonts.ts (regenerating that file is documented there). This replaces the earlier
  // html2canvas-screenshot approach, which produced blurry, unstructured pages when zoomed
  // (Axel, 2026-09-03: "c est pas structure, c est soupe ... je veux un vrai pdf") — this version
  // instead measures and lays out each header/row itself. Rows are drawn compact (Axel, same
  // message: "et reduit la taille des lignes").
  async function exportReportPdf() {
    if (!dailyReport) return;
    setReportExporting(true);
    setReportMsg(null);
    try {
      const [{ jsPDF }, { NOTO_SANS_VN_REGULAR_BASE64, NOTO_SANS_VN_BOLD_BASE64 }] = await Promise.all([
        import('jspdf'),
        import('@/lib/pdf-fonts'),
      ]);

      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      pdf.addFileToVFS('NotoSansVN-Regular.ttf', NOTO_SANS_VN_REGULAR_BASE64);
      pdf.addFont('NotoSansVN-Regular.ttf', 'NotoSansVN', 'normal');
      pdf.addFileToVFS('NotoSansVN-Bold.ttf', NOTO_SANS_VN_BOLD_BASE64);
      pdf.addFont('NotoSansVN-Bold.ttf', 'NotoSansVN', 'bold');
      pdf.setFont('NotoSansVN', 'normal');

      const MARGIN = 32;
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const contentWidth = pageWidth - MARGIN * 2;
      const usableBottom = pageHeight - MARGIN - 14; // reserve room for the page-number footer

      const DARK: [number, number, number] = [31, 41, 55];
      const GRAY: [number, number, number] = [107, 114, 128];
      const LIGHT_GRAY: [number, number, number] = [156, 163, 175];
      const RED: [number, number, number] = [220, 38, 38];
      const HEADER_BG: [number, number, number] = [243, 244, 246];
      const DIVIDER: [number, number, number] = [229, 231, 235];

      // Compact rows (Axel: "reduit la taille des lignes") — small font, tight row height.
      const ROW_FONT = 8;
      const ROW_H = 12.5;
      const CAT_HEADER_FONT = 8;
      const CAT_HEADER_H = 14;
      const SECTION_TITLE_FONT = 9.5;
      const SECTION_TITLE_H = 16;

      let cursorY = MARGIN;

      const ensureSpace = (h: number) => {
        if (cursorY + h > usableBottom) {
          pdf.addPage();
          cursorY = MARGIN;
        }
      };

      // Truncates with an ellipsis instead of wrapping, so every row stays exactly one line tall.
      const fitText = (text: string, maxWidth: number): string => {
        if (pdf.getTextWidth(text) <= maxWidth) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (pdf.getTextWidth(text.slice(0, mid) + '…') <= maxWidth) lo = mid;
          else hi = mid - 1;
        }
        return lo > 0 ? text.slice(0, lo) + '…' : '…';
      };

      const drawDivider = (y: number) => {
        pdf.setDrawColor(...DIVIDER);
        pdf.setLineWidth(0.4);
        pdf.line(MARGIN, y, pageWidth - MARGIN, y);
      };

      const drawCategoryHeader = (label: string) => {
        // Never leave a lone header at the bottom of a page — it must fit alongside one row.
        if (cursorY + CAT_HEADER_H + ROW_H > usableBottom) {
          pdf.addPage();
          cursorY = MARGIN;
        }
        pdf.setFillColor(...HEADER_BG);
        pdf.rect(MARGIN, cursorY, contentWidth, CAT_HEADER_H, 'F');
        pdf.setFont('NotoSansVN', 'bold');
        pdf.setFontSize(CAT_HEADER_FONT);
        pdf.setTextColor(...GRAY);
        pdf.text(label.toUpperCase(), MARGIN + 6, cursorY + CAT_HEADER_H / 2, { baseline: 'middle' });
        cursorY += CAT_HEADER_H;
      };

      const drawProductRow = (name: string, qtyLabel: string, color: [number, number, number], bold: boolean) => {
        ensureSpace(ROW_H);
        const qtyWidth = 64;
        pdf.setFont('NotoSansVN', bold ? 'bold' : 'normal');
        pdf.setFontSize(ROW_FONT);
        pdf.setTextColor(...color);
        pdf.text(fitText(name, contentWidth - qtyWidth - 10), MARGIN + 6, cursorY + ROW_H / 2, { baseline: 'middle' });
        pdf.setFont('NotoSansVN', 'bold');
        pdf.text(qtyLabel, pageWidth - MARGIN - 6, cursorY + ROW_H / 2, { baseline: 'middle', align: 'right' });
        drawDivider(cursorY + ROW_H);
        cursorY += ROW_H;
      };

      // ── Header ──
      pdf.setFont('NotoSansVN', 'bold');
      pdf.setFontSize(13);
      pdf.setTextColor(...DARK);
      pdf.text(shopName, MARGIN, cursorY, { baseline: 'top' });
      cursorY += 17;
      pdf.setFont('NotoSansVN', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(...GRAY);
      pdf.text(`Báo cáo cuối ngày · ${fmtDate(dailyReport.date)}`, MARGIN, cursorY, { baseline: 'top' });
      cursorY += 14;
      drawDivider(cursorY);
      cursorY += 12;

      // ── Kiểm kho progress ──
      ensureSpace(SECTION_TITLE_H);
      pdf.setFont('NotoSansVN', 'bold');
      pdf.setFontSize(SECTION_TITLE_FONT);
      pdf.setTextColor(...GRAY);
      pdf.text('KIỂM KHO', MARGIN, cursorY, { baseline: 'top' });
      pdf.setTextColor(...DARK);
      pdf.text(`${dailyReport.stockCountedCount}/${dailyReport.stockTotalCount} đã kiểm`, pageWidth - MARGIN, cursorY, {
        baseline: 'top',
        align: 'right',
      });
      cursorY += SECTION_TITLE_H + 4;

      // ── Stock lines, by category ──
      for (const g of groupStockByCategory(dailyReport.stockLines)) {
        drawCategoryHeader(g.category);
        for (const l of g.lines) {
          if (l.qty === null) {
            drawProductRow(l.name, 'Chưa kiểm', LIGHT_GRAY, false);
          } else if (l.qty === 0) {
            drawProductRow(l.name, '0', RED, true);
          } else {
            drawProductRow(l.name, String(l.qty), DARK, false);
          }
        }
        cursorY += 8;
      }

      // ── Losses ── (drawCategoryHeader below already guards its own space + header-orphan check)
      const lossesTitle = `HAO HỤT HÔM NAY${dailyReport.lossesReportCount ? ` · ${dailyReport.lossesReportCount} báo cáo` : ''}`;
      drawCategoryHeader(lossesTitle);
      if (!dailyReport.losses.length) {
        ensureSpace(ROW_H);
        pdf.setFont('NotoSansVN', 'normal');
        pdf.setFontSize(ROW_FONT);
        pdf.setTextColor(...LIGHT_GRAY);
        pdf.text('Không có hao hụt hôm nay', MARGIN + 6, cursorY + ROW_H / 2, { baseline: 'middle' });
        cursorY += ROW_H;
      } else {
        for (const p of dailyReport.losses) {
          drawProductRow(p.productName, `×${p.qty}`, RED, true);
        }
      }

      // ── Page numbers ──
      const totalPages = pdf.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p);
        pdf.setFont('NotoSansVN', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...LIGHT_GRAY);
        pdf.text(`Trang ${p}/${totalPages}`, pageWidth / 2, pageHeight - 18, { baseline: 'top', align: 'center' });
      }

      pdf.save(`bao-cao-${shopName}-${dailyReport.date}.pdf`);
    } catch {
      setReportMsg('Lỗi khi xuất PDF, vui lòng thử lại.');
    } finally {
      setReportExporting(false);
    }
  }

  // ── Đặt hàng ──
  // Explicit "Lưu nháp" — any staff, no PIN. Also called implicitly right before the confirm
  // modal opens, so nothing typed is ever lost even if the PIN step gets cancelled.
  async function saveOrderDraft(): Promise<boolean> {
    const name = orderCreatedByName.trim();
    if (!name) { setOrderMsg('Chọn tên trước khi lưu nháp'); return false; }
    if (!orderDeliveryDate || !orderCart.some(l => l.qty > 0)) return false;
    setOrderDraftSaving(true);
    const actions = await import('./actions');
    const res = await actions.saveManagerOrderDraftAction({
      ...(readOnly ? { shopName } : {}),
      createdByName: name,
      deliveryDate: orderDeliveryDate,
      deliveryTime: orderDeliveryTime,
      lines: orderCart.filter(l => l.qty > 0).map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note.trim() || undefined })),
    });
    setOrderDraftSaving(false);
    if (res.error) { setOrderMsg(`Lỗi: ${res.error}`); return false; }
    setOrderDraftLoaded(res.draft ?? null);
    return true;
  }

  async function discardOrderDraft() {
    if (!orderDeliveryDate) return;
    const actions = await import('./actions');
    await actions.discardManagerOrderDraftAction(orderDeliveryDate, readOnly ? shopName : undefined);
    setOrderDraftLoaded(null);
    setOrderCart([]);
    setOrderMsg(null);
  }

  // Sets a product's cart quantity directly (adds it if new, updates in place if already
  // there) — used by the browse/search result rows' +/- steppers so a manager can tap down a
  // whole category or a run of search matches without the list closing after each one (Axel,
  // 2026-09-03: "faciliter l'ajout de produit, pas forcement 1 par 1").
  function setOrderQtyForProduct(p: ShopManagerCatalogProduct, qty: number) {
    const clamped = Math.max(0, Math.floor(qty) || 0);
    setOrderCart(prev => {
      const exists = prev.some(l => l.sku === p.sku);
      if (!exists) return clamped > 0 ? [...prev, { sku: p.sku, name: p.name, qty: clamped, note: '', imageUrl: p.imageUrl }] : prev;
      return prev.map(l => l.sku === p.sku ? { ...l, qty: clamped } : l);
    });
  }

  function updateOrderQty(sku: string, qty: number) {
    setOrderCart(prev => prev.map(l => l.sku === sku ? { ...l, qty: Math.max(0, Math.floor(qty) || 0) } : l));
  }

  function updateOrderNote(sku: string, note: string) {
    setOrderCart(prev => prev.map(l => l.sku === sku ? { ...l, note } : l));
  }

  function removeOrderItem(sku: string) {
    setOrderCart(prev => prev.filter(l => l.sku !== sku));
  }

  // The one moment a manager's PIN is actually required — re-verified server-side inside
  // submitManagerOrderAction itself (Axel, 2026-09-05: "la confirmation se fait par le manager
  // avec son code pin"). A wrong PIN keeps the modal open with an inline error instead of
  // closing it, so the manager can just retype it.
  async function confirmOrder() {
    if (!orderConfirmPin.trim()) { setOrderConfirmMsg('Nhập mã PIN quản lý'); return; }
    setOrderSubmitting(true);
    setOrderConfirmMsg(null);
    const actions = await import('./actions');
    const res = await actions.submitManagerOrderAction({
      pin: orderConfirmPin.trim(),
      ...(readOnly ? { shopName } : {}),
      deliveryDate: orderDeliveryDate ?? '',
      deliveryTime: orderDeliveryTime,
      lines: orderCart.filter(l => l.qty > 0).map(l => ({ sku: l.sku, name: l.name, qty: l.qty, note: l.note.trim() || undefined })),
    });
    setOrderSubmitting(false);
    if (res.error || !res.orderRef || !res.deliveryDate) { setOrderConfirmMsg(res.error ?? 'Lỗi không rõ'); return; }
    setOrderPendingConfirm(false);
    setOrderConfirmPin('');
    setOrderResult({ orderRef: res.orderRef, deliveryDate: res.deliveryDate, deliveryTime: res.deliveryTime, managerName: res.managerName });
    setOrderCart([]);
    setOrderDraftLoaded(null);
  }

  // Saves whatever's in the cart as a draft first (so nothing is lost if the PIN step is
  // cancelled), then opens the confirm-and-PIN modal.
  async function openOrderConfirm() {
    setOrderMsg(null);
    await saveOrderDraft();
    setOrderConfirmPin('');
    setOrderConfirmMsg(null);
    setOrderPendingConfirm(true);
  }

  function newOrder() {
    setOrderResult(null);
    setOrderMsg(null);
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

  // Kiểm kho category filter + per-category completion (Axel, 2026-09-03: "je voudrais que tu
  // mettes un filtre par categorie et une fois qu une categorie est check en entier la categorie
  // s affiche en vert") — "checked" means every line in that category has a non-empty value in
  // the live draft (stockDraft), not the last-saved qty, so the category turns green the moment
  // the last product in it is typed in, even before "Lưu kiểm kho" is pressed.
  const stockGroups = stockLines ? groupStockByCategory(stockLines) : [];
  const stockGroupsWithProgress = stockGroups.map(g => ({
    ...g,
    filled: g.lines.filter(l => (stockDraft[l.sku] ?? '').trim() !== '').length,
  }));
  const visibleStockGroups = stockCategoryFilter
    ? stockGroupsWithProgress.filter(g => g.category === stockCategoryFilter)
    : stockGroupsWithProgress;

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
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setTab('deliveries')}
            className="flex-1 basis-[31%] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'deliveries' ? '#1f2937' : 'white', color: tab === 'deliveries' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Truck size={16} /> Giao hàng
          </button>
          <button onClick={() => setTab('cakes')}
            className="flex-1 basis-[31%] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'cakes' ? '#1f2937' : 'white', color: tab === 'cakes' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Cake size={16} /> Bánh sinh nhật
          </button>
          <button onClick={() => setTab('losses')}
            className="flex-1 basis-[31%] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'losses' ? '#1f2937' : 'white', color: tab === 'losses' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Trash2 size={16} /> Hao hụt
          </button>
          <button onClick={() => setTab('stock')}
            className="flex-1 basis-[31%] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'stock' ? '#1f2937' : 'white', color: tab === 'stock' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <ClipboardList size={16} /> Kiểm kho
          </button>
          <button onClick={() => setTab('report')}
            className="flex-1 basis-[31%] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'report' ? '#1f2937' : 'white', color: tab === 'report' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <FileText size={16} /> Báo cáo
          </button>
          <button onClick={() => setTab('order')}
            className="flex-1 basis-[31%] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2.5"
            style={{ backgroundColor: tab === 'order' ? '#1f2937' : 'white', color: tab === 'order' ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
            <Package2 size={16} /> Đặt hàng
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
                                <img src={thumb(l.image_url, 112)} alt="" className="w-full h-full object-cover" />
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
                            <img src={thumb(lossProduct.main_image_url, 80)} alt="" className="w-full h-full object-cover" />
                          </button>
                        )}
                        <span className="font-semibold truncate">
                          {lossProduct.name_vi}{lossProduct.variantLabel ? ` — ${lossProduct.variantLabel}` : ''}{lossProduct.sku ? ` (${lossProduct.sku})` : ''}
                        </span>
                      </span>
                      <button onClick={() => { setLossProduct(null); setLossQuery(''); }} className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>Đổi</button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
                      <input type="text" value={lossQuery} onChange={e => setLossQuery(e.target.value)}
                        placeholder="Tìm sản phẩm…" className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                      {lossQuery.trim().length >= 2 && (
                        <div className="mt-1 rounded-lg overflow-y-auto overscroll-contain max-h-64"
                          style={{ border: '1px solid #E5E7EB', WebkitOverflowScrolling: 'touch' }}>
                          {lossSearching ? (
                            <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Đang tìm…</div>
                          ) : !lossResults.length ? (
                            <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Không tìm thấy</div>
                          ) : flattenForPicker(lossResults).map(p => (
                            <button key={p.id} onClick={() => { setLossProduct(p); setLossResults([]); }}
                              className="w-full text-left px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2" style={{ borderColor: '#F3F4F6' }}>
                              {p.main_image_url && <img src={thumb(p.main_image_url, 80)} alt="" className="w-8 h-8 rounded object-cover shrink-0" />}
                              <span className="truncate">
                                {p.name_vi}{p.variantLabel ? <span style={{ color: '#6B7280' }}> — {p.variantLabel}</span> : null}
                                {p.sku ? <span style={{ color: '#9CA3AF' }}> · {p.sku}</span> : null}
                              </span>
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
                          <img src={thumb(item.product.main_image_url, 80)} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold truncate">
                            {item.product.name_vi}{item.product.variantLabel ? ` — ${item.product.variantLabel}` : ''} <span style={{ color: '#9CA3AF', fontWeight: 400 }}>×{item.qty}</span>
                          </div>
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
{dailyRecap && dailyRecap.length > 0 && (
            <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
              <div className="px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Tổng hao hụt 7 ngày qua</div>
              </div>
              <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                {dailyRecap.map(r => (
                  <div key={r.date} className="px-4 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-navy">{fmtDate(r.date)}</span>
                      <span className="text-sm">
                        <span className="font-bold">{r.totalQty}</span>
                        <span className="ml-1.5" style={{ color: '#9CA3AF' }}>· {r.reportCount} báo cáo</span>
                      </span>
                    </div>
                    {r.products.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {r.products.map(p => (
                          <div key={p.productName} className="flex items-center justify-between gap-2 text-xs" style={{ color: '#6B7280' }}>
                            <span className="truncate">{p.productName}</span>
                            <span className="font-semibold shrink-0" style={{ color: '#374151' }}>×{p.qty}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
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
        ) : tab === 'stock' ? (
          <div className="space-y-3">
            <div className="bg-white rounded-2xl p-4 space-y-2.5" style={{ border: '1px solid #E5E7EB' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
                  Kiểm kho hôm nay{stockDate ? ` · ${fmtDate(stockDate)}` : ''}
                </div>
                {stockSessionSeq >= stockLatestSessionSeq && stockSessions.some(s => s.seq === stockLatestSessionSeq) && (
                  <button type="button" onClick={() => setStockNewSessionConfirm(true)}
                    className="shrink-0 text-[11px] font-bold rounded-full px-2.5 py-1" style={{ border: '1px solid #D1D5DB', color: '#1f2937' }}>
                    🆕 Đợt mới
                  </button>
                )}
              </div>
              {/* Axel, 2026-09-05: "plusieurs inventaire par jour" — a shop can run several
                  distinct counts today (matin/chiều/tối…); each chip below is one of them, in
                  order. Only the latest (or the not-yet-saved next one) is still editable —
                  tapping an older one just previews it read-only-ish (saving still targets the
                  current session, see saveStockCountAction). */}
              {(stockSessions.length > 1 || stockSessionSeq !== stockLatestSessionSeq) && (
                <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ WebkitOverflowScrolling: 'touch' }}>
                  {Array.from(new Set([...stockSessions.map(s => s.seq), stockLatestSessionSeq, stockSessionSeq])).sort((a, b) => a - b).map(seq => {
                    const active = seq === stockSessionSeq;
                    const isLocked = seq < stockLatestSessionSeq;
                    return (
                      <button key={seq} type="button" onClick={() => loadStock(seq)}
                        className="shrink-0 text-[11px] font-bold rounded-full px-2.5 py-1"
                        style={{
                          backgroundColor: active ? '#1f2937' : 'white', color: active ? 'white' : '#374151',
                          border: `1px solid ${active ? '#1f2937' : '#D1D5DB'}`,
                        }}>
                        Đợt {seq}{isLocked ? ' 🔒' : ''}
                      </button>
                    );
                  })}
                </div>
              )}
              {stockNewSessionConfirm && (
                <div className="rounded-lg p-2.5 space-y-1.5" style={{ backgroundColor: '#FEF9C3' }}>
                  <div className="text-[11px] font-semibold" style={{ color: '#854D0E' }}>
                    Bắt đầu đợt kiểm kho mới sẽ khoá đợt {stockLatestSessionSeq} lại (không sửa được nữa) — tiếp tục?
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setStockNewSessionConfirm(false)} className="flex-1 text-xs font-bold rounded-lg px-2 py-1.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>Huỷ</button>
                    <button onClick={startNewStockSession} className="flex-1 text-xs font-bold rounded-lg px-2 py-1.5 text-white" style={{ backgroundColor: '#1f2937' }}>Bắt đầu</button>
                  </div>
                </div>
              )}
              {stockSessionSeq < stockLatestSessionSeq && (
                <div className="text-[11px] font-semibold" style={{ color: '#9CA3AF' }}>Đang xem lại đợt {stockSessionSeq} (đã khoá) — chọn đợt {stockLatestSessionSeq} ở trên để tiếp tục kiểm kho.</div>
              )}
              <div>
                <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Tên của bạn</div>
                <NamePicker value={stockName} onChange={setStockName} names={staffNames} onManage={() => setShowStaffModal(true)} />
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 space-y-2" style={{ border: '1px solid #E5E7EB' }}>
              <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Thêm sản phẩm không có trong danh sách</div>
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
                <input type="text" value={stockSearchQuery} onChange={e => setStockSearchQuery(e.target.value)}
                  placeholder="Tìm sản phẩm…" className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                {stockSearchQuery.trim().length >= 2 && (
                  <div className="mt-1 rounded-lg overflow-y-auto overscroll-contain max-h-64"
                    style={{ border: '1px solid #E5E7EB', WebkitOverflowScrolling: 'touch' }}>
                    {stockSearching ? (
                      <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Đang tìm…</div>
                    ) : !stockSearchResults.length ? (
                      <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Không tìm thấy</div>
                    ) : stockSearchResults.map(p => (
                      <button key={p.sku} onClick={() => addStockItem(p)}
                        className="w-full text-left px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2" style={{ borderColor: '#F3F4F6' }}>
                        {p.imageUrl && <img src={thumb(p.imageUrl, 80)} alt="" className="w-8 h-8 rounded object-cover shrink-0" />}
                        <span className="truncate">{p.name}<span style={{ color: '#9CA3AF' }}> · {p.sku}</span></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {stockLoading && stockLines === null ? (
              <div className="text-center py-6 text-sm" style={{ color: '#6B7280' }}>Đang tải…</div>
            ) : !stockLines?.length ? (
              <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
                Chưa có sản phẩm nào — thêm sản phẩm ở trên hoặc quay lại sau khi có đơn hàng
              </div>
            ) : (
              <>
                <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
                  <button type="button" onClick={() => setStockCategoryFilter(null)}
                    className="shrink-0 inline-flex items-center gap-1 text-xs font-bold rounded-full px-3 py-1.5"
                    style={{
                      backgroundColor: stockCategoryFilter === null ? '#1f2937' : 'white',
                      color: stockCategoryFilter === null ? 'white' : '#374151',
                      border: `1px solid ${stockCategoryFilter === null ? '#1f2937' : '#D1D5DB'}`,
                    }}>
                    Tất cả
                  </button>
                  {stockGroupsWithProgress.map(g => {
                    const isComplete = g.filled === g.lines.length;
                    const active = stockCategoryFilter === g.category;
                    return (
                      <button key={g.category} type="button" onClick={() => setStockCategoryFilter(g.category)}
                        className="shrink-0 inline-flex items-center gap-1 text-xs font-bold rounded-full px-3 py-1.5"
                        style={{
                          backgroundColor: active ? '#1f2937' : isComplete ? '#DCFCE7' : 'white',
                          color: active ? 'white' : isComplete ? '#166534' : '#374151',
                          border: `1px solid ${active ? '#1f2937' : isComplete ? '#86EFAC' : '#D1D5DB'}`,
                        }}>
                        {isComplete && <Check size={12} />}
                        {g.category} ({g.filled}/{g.lines.length})
                      </button>
                    );
                  })}
                </div>

              <div className="space-y-3">
                {visibleStockGroups.map(g => {
                  const isComplete = g.filled === g.lines.length;
                  return (
                  <div key={g.category} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                    <div className="px-4 py-2" style={{ backgroundColor: isComplete ? '#DCFCE7' : '#F9FAFB' }}>
                      <div className="text-xs font-bold uppercase tracking-wide flex items-center gap-1" style={{ color: isComplete ? '#166534' : '#6B7280' }}>
                        {isComplete && <Check size={12} />}
                        {g.category}
                      </div>
                    </div>
                    <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                      {g.lines.map(l => (
                        <div key={l.sku} className="px-4 py-2.5 flex items-center gap-3">
                          {l.imageUrl ? (
                            <button type="button" onClick={() => setZoomImage(l.imageUrl!)}
                              className="shrink-0 w-10 h-10 rounded overflow-hidden" aria-label="Xem ảnh sản phẩm">
                              <img src={thumb(l.imageUrl, 80)} alt="" className="w-full h-full object-cover" />
                            </button>
                          ) : (
                            <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: '#F3F4F6' }} />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{l.name}</div>
                            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{l.sku}{l.isExtra ? ' · đã thêm' : ''}</div>
                          </div>
                          <input type="number" min={0} step="1" inputMode="decimal" disabled={stockSessionSeq < stockLatestSessionSeq}
                            value={stockDraft[l.sku] ?? ''} onChange={e => setStockDraft(p => ({ ...p, [l.sku]: e.target.value }))}
                            placeholder="—" className="w-20 rounded-lg px-2.5 py-1.5 text-sm font-bold text-right shrink-0 disabled:opacity-50" style={{ border: '1px solid #D1D5DB' }} />
                        </div>
                      ))}
                    </div>
                  </div>
                  );
                })}
              </div>
              </>
            )}

            <button onClick={saveStockCount}
              disabled={stockSaving || !stockName.trim() || !stockLines?.length || stockSessionSeq < stockLatestSessionSeq}
              className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 text-white disabled:opacity-40"
              style={{ backgroundColor: '#1f2937' }}>
              {stockSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Lưu kiểm kho
            </button>
            {stockMsg && <div className="text-xs font-semibold" style={{ color: stockMsg.startsWith('Lỗi') ? '#DC2626' : '#059669' }}>{stockMsg}</div>}
          </div>
        ) : tab === 'report' ? (
          <div className="space-y-3">
            <div className="space-y-3">
              <div className="bg-white rounded-2xl p-4" style={{ border: '1px solid #E5E7EB' }}>
                <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
                  Báo cáo cuối ngày{dailyReport ? ` · ${fmtDate(dailyReport.date)}` : ''}
                </div>
                <div className="text-sm font-bold text-navy mt-0.5">{shopName}</div>
              </div>

              {reportLoading && !dailyReport ? (
                <div className="text-center py-6 text-sm" style={{ color: '#6B7280' }}>Đang tải…</div>
              ) : !dailyReport ? null : !dailyReport.stockCounted ? (
                <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
                  Chưa kiểm kho hôm nay — vui lòng kiểm kho trước khi xem báo cáo.
                </div>
              ) : (
                <>
                  <div className="bg-white rounded-2xl px-4 py-3 flex items-center justify-between" style={{ border: '1px solid #E5E7EB' }}>
                    <span className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Kiểm kho</span>
                    <span className="text-sm font-bold text-navy">{dailyReport.stockCountedCount}/{dailyReport.stockTotalCount} đã kiểm</span>
                  </div>

                  <div className="space-y-3">
                    {groupStockByCategory(dailyReport.stockLines).map(g => (
                      <div key={g.category} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                        <div className="px-4 py-2" style={{ backgroundColor: '#F9FAFB' }}>
                          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>{g.category}</div>
                        </div>
                        <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                          {g.lines.map(l => (
                            <div key={l.sku} className="px-4 py-2 flex items-center justify-between gap-3">
                              <span className="text-sm truncate" style={{ color: l.qty === 0 ? '#DC2626' : '#1f2937', fontWeight: l.qty === 0 ? 700 : 400 }}>{l.name}</span>
                              <span className="text-sm font-bold shrink-0" style={{ color: l.qty === 0 ? '#DC2626' : l.qty === null ? '#9CA3AF' : '#1f2937' }}>
                                {l.qty === null ? 'Chưa kiểm' : l.qty}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                    <div className="px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                      <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
                        Hao hụt hôm nay{dailyReport.lossesReportCount ? ` · ${dailyReport.lossesReportCount} báo cáo` : ''}
                      </div>
                    </div>
                    {!dailyReport.losses.length ? (
                      <div className="px-4 py-3 text-sm" style={{ color: '#9CA3AF' }}>Không có hao hụt hôm nay</div>
                    ) : (
                      <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                        {dailyReport.losses.map(p => (
                          <div key={p.productName} className="px-4 py-2 flex items-center justify-between gap-2">
                            <span className="text-sm truncate">{p.productName}</span>
                            <span className="text-sm font-bold shrink-0" style={{ color: '#DC2626' }}>×{p.qty}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {dailyReport?.stockCounted && (
              <button onClick={exportReportPdf} disabled={reportExporting}
                className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 text-white disabled:opacity-40"
                style={{ backgroundColor: '#1f2937' }}>
                {reportExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Xuất PDF
              </button>
            )}
            {reportMsg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{reportMsg}</div>}
          </div>
        ) : tab === 'order' ? (
          <div className="space-y-3">
            {orderResult ? (
              <div className="bg-white rounded-2xl p-6 space-y-3 text-center" style={{ border: '1px solid #E5E7EB' }}>
                <CheckCircle2 size={32} className="mx-auto" style={{ color: '#16A34A' }} />
                <div className="text-sm font-bold text-navy">Đã xác nhận đơn hàng</div>
                <div className="text-xs" style={{ color: '#6B7280' }}>Giao hàng dự kiến: {fmtDate(orderResult.deliveryDate)}{orderResult.deliveryTime ? ` lúc ${orderResult.deliveryTime}` : ''}{orderResult.managerName ? ` · Quản lý: ${orderResult.managerName}` : ''}</div>
                <div className="rounded-xl px-4 py-3" style={{ backgroundColor: '#F9FAFB' }}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Mã đơn Odoo</div>
                  <div className="text-lg font-bold" style={{ color: '#1f2937' }}>{orderResult.orderRef}</div>
                </div>
                <button onClick={newOrder} className="w-full text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: '#1f2937' }}>
                  Đặt đơn khác
                </button>
              </div>
            ) : (
              <>
                <div className="bg-white rounded-2xl p-4 space-y-2.5" style={{ border: '1px solid #E5E7EB' }}>
                  <div>
                    <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Tên của bạn</div>
                    <NamePicker value={orderCreatedByName} onChange={setOrderCreatedByName} names={staffNames} onManage={() => setShowStaffModal(true)} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Truck size={14} className="shrink-0" style={{ color: '#9CA3AF' }} />
                    <span className="text-xs font-semibold shrink-0" style={{ color: '#6B7280' }}>Giao hàng:</span>
                    <input type="date" value={orderDeliveryDate ?? ''} min={orderMinDate ?? undefined}
                      onChange={e => setOrderDeliveryDate(e.target.value)}
                      className="flex-1 min-w-0 rounded-lg px-2 py-1 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
                    <input type="time" value={orderDeliveryTime} onChange={e => setOrderDeliveryTime(e.target.value)}
                      className="w-[92px] shrink-0 rounded-lg px-2 py-1 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
                  </div>
                  <div className="text-[11px] font-semibold" style={{ color: '#DC2626' }}>
                    {orderDeliveryDate && orderMinDate && orderDeliveryDate === orderMinDate
                      ? (orderTomorrowOpen
                        ? 'Đặt cho ngày mai: ai cũng thêm được sản phẩm, nhưng cần quản lý xác nhận bằng mã PIN trước 14h00 — nếu chưa ai xác nhận, đơn sẽ tự động gửi lúc 14h00.'
                        : 'Đã hết giờ đặt cho ngày mai (trước 14h00) — vui lòng chọn từ ngày kia trở đi.')
                      : 'Đặt cho ngày này: ai cũng thêm được sản phẩm, quản lý xác nhận bằng mã PIN khi sẵn sàng (không giới hạn giờ).'}
                  </div>
                  {orderDraftLoaded && (
                    <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#FEF9C3' }}>
                      <span className="text-[11px] font-semibold truncate" style={{ color: '#854D0E' }}>
                        📝 Nháp {orderDraftLoaded.createdByName ? `của ${orderDraftLoaded.createdByName} · ` : ''}cập nhật {new Date(orderDraftLoaded.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button onClick={discardOrderDraft} className="text-[11px] font-bold shrink-0" style={{ color: '#DC2626' }}>Xoá nháp</button>
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-2xl p-4 space-y-2" style={{ border: '1px solid #E5E7EB' }}>
                  <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Thêm sản phẩm</div>
                  {orderCategories.length > 0 && (
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-0.5 px-0.5" style={{ WebkitOverflowScrolling: 'touch' }}>
                      <button onClick={() => setOrderCategoryFilter(null)}
                        className="shrink-0 text-xs font-semibold rounded-full px-3 py-1.5"
                        style={{ backgroundColor: !orderCategoryFilter ? '#1f2937' : 'white', color: !orderCategoryFilter ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
                        Tất cả
                      </button>
                      {orderCategories.map(cat => (
                        <button key={cat} onClick={() => setOrderCategoryFilter(prev => prev === cat ? null : cat)}
                          className="shrink-0 text-xs font-semibold rounded-full px-3 py-1.5"
                          style={{ backgroundColor: orderCategoryFilter === cat ? '#1f2937' : 'white', color: orderCategoryFilter === cat ? 'white' : '#1f2937', border: '1px solid #D1D5DB' }}>
                          {cat}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
                    <input type="text" value={orderSearchQuery} onChange={e => setOrderSearchQuery(e.target.value)}
                      placeholder="Tìm sản phẩm hoặc packaging…" className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                  </div>
                  {(orderSearchQuery.trim().length >= 2 || orderCategoryFilter) && (
                    <div className="rounded-lg overflow-y-auto overscroll-contain max-h-72"
                      style={{ border: '1px solid #E5E7EB', WebkitOverflowScrolling: 'touch' }}>
                      {orderSearching ? (
                        <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Đang tìm…</div>
                      ) : !orderSearchResults.length ? (
                        <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>Không tìm thấy</div>
                      ) : orderSearchResults.map(p => {
                        const qtyInCart = orderCart.find(l => l.sku === p.sku)?.qty ?? 0;
                        return (
                          <div key={p.sku} className="px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2.5" style={{ borderColor: '#F3F4F6' }}>
                            {p.imageUrl ? (
                              <button type="button" onClick={() => setZoomImage(p.imageUrl!)}
                                className="shrink-0 w-10 h-10 rounded overflow-hidden" aria-label="Xem ảnh sản phẩm">
                                <img src={thumb(p.imageUrl, 80)} alt="" className="w-full h-full object-cover" />
                              </button>
                            ) : (
                              <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: '#F3F4F6' }} />
                            )}
                            <span className="truncate flex-1 min-w-0">{p.name}<span style={{ color: '#9CA3AF' }}> · {p.sku}{p.isPackaging ? ' · packaging' : ''}</span></span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button onClick={() => setOrderQtyForProduct(p, qtyInCart - 1)} disabled={qtyInCart <= 0}
                                className="w-6 h-6 rounded-md flex items-center justify-center disabled:opacity-30" style={{ border: '1px solid #D1D5DB' }}>
                                <Minus size={11} />
                              </button>
                              <span className="w-5 text-center text-xs font-bold">{qtyInCart}</span>
                              <button onClick={() => setOrderQtyForProduct(p, qtyInCart + 1)}
                                className="w-6 h-6 rounded-md flex items-center justify-center" style={{ border: '1px solid #D1D5DB' }}>
                                <Plus size={11} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {!orderCart.length ? (
                  <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ color: '#9CA3AF', border: '1px solid #E5E7EB' }}>
                    Giỏ hàng trống — tìm và thêm sản phẩm ở trên
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                    <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                      {orderCart.map(l => (
                        <div key={l.sku} className="px-4 py-2.5 space-y-1.5">
                          <div className="flex items-center gap-2.5">
                            {l.imageUrl ? (
                              <button type="button" onClick={() => setZoomImage(l.imageUrl!)}
                                className="shrink-0 w-10 h-10 rounded overflow-hidden" aria-label="Xem ảnh sản phẩm">
                                <img src={thumb(l.imageUrl, 80)} alt="" className="w-full h-full object-cover" />
                              </button>
                            ) : (
                              <div className="shrink-0 w-10 h-10 rounded" style={{ backgroundColor: '#F3F4F6' }} />
                            )}
                            <span className="text-sm font-semibold truncate flex-1 min-w-0">{l.name}</span>
                            <button onClick={() => removeOrderItem(l.sku)} className="shrink-0"><Trash2 size={14} style={{ color: '#DC2626' }} /></button>
                          </div>
                          <div className="flex items-center gap-2">
                            <button onClick={() => updateOrderQty(l.sku, l.qty - 1)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ border: '1px solid #D1D5DB' }}>
                              <Minus size={12} />
                            </button>
                            <input type="number" value={l.qty} onChange={e => updateOrderQty(l.sku, Number(e.target.value))}
                              className="w-14 text-center rounded-lg py-1 text-sm font-bold shrink-0" style={{ border: '1px solid #D1D5DB' }} />
                            <button onClick={() => updateOrderQty(l.sku, l.qty + 1)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ border: '1px solid #D1D5DB' }}>
                              <Plus size={12} />
                            </button>
                            <input type="text" value={l.note} onChange={e => updateOrderNote(l.sku, e.target.value)}
                              placeholder="Ghi chú (tuỳ chọn)" className="flex-1 min-w-0 rounded-lg px-2.5 py-1 text-xs" style={{ border: '1px solid #D1D5DB' }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {orderMsg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{orderMsg}</div>}

                <div className="flex gap-2">
                  <button onClick={saveOrderDraft} disabled={!orderCart.some(l => l.qty > 0) || !orderCreatedByName.trim() || orderDraftSaving}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 disabled:opacity-40"
                    style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                    {orderDraftSaving ? <Loader2 size={14} className="animate-spin" /> : null}
                    Lưu nháp
                  </button>
                  <button onClick={openOrderConfirm} disabled={!orderCart.some(l => l.qty > 0) || orderSubmitting || (orderDeliveryDate === orderMinDate && !orderTomorrowOpen)}
                    className="flex-[2] inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40"
                    style={{ backgroundColor: '#1f2937' }}>
                    {orderSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Xác nhận đơn hàng
                  </button>
                </div>
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

      {/* Full-screen photo viewer — tap any thumbnail (receipt line or scrap picker) to open. */}
      {zoomImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
          onClick={() => setZoomImage(null)}>
          <img src={thumb(zoomImage, 1200)} alt="" className="max-w-full max-h-full rounded-xl" onClick={e => e.stopPropagation()} />
        </div>
      )}

      {/* Double-check before confirming a receipt — nothing is saved until "Xác nhận" here. */}
      {pendingReceipt && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>Xác nhận nhận hàng</div>
            <div className="flex items-center gap-3">
              {pendingReceipt.line.image_url && (
                <img src={thumb(pendingReceipt.line.image_url, 128)} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E5E7EB' }} />
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
                    <img src={thumb(item.product.main_image_url, 112)} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0" style={{ border: '1px solid #FCA5A5' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-navy truncate">
                      {item.product.name_vi}{item.product.variantLabel ? ` — ${item.product.variantLabel}` : ''}{item.product.sku ? ` (${item.product.sku})` : ''}
                    </div>
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

      {/* Double-check before a manager order — this goes straight to Odoo (create + auto-confirm
          the REP order), so nothing fires until "Xác nhận" here, same posture as the loss-report
          modal above (Axel, 2026-09-03 phase 3). */}
      {orderPendingConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
              Xác nhận đơn hàng ({orderCart.filter(l => l.qty > 0).length} sản phẩm)
            </div>
            <div className="text-xs" style={{ color: '#6B7280' }}>
              Giao hàng: {orderDeliveryDate ? fmtDate(orderDeliveryDate) : '…'}{orderDeliveryTime ? ` lúc ${orderDeliveryTime}` : ''}
            </div>
            <div className="space-y-1.5">
              {orderCart.filter(l => l.qty > 0).map(l => (
                <div key={l.sku} className="flex items-center gap-2.5 rounded-xl p-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                  {l.imageUrl ? (
                    <img src={thumb(l.imageUrl, 80)} alt="" className="shrink-0 w-8 h-8 rounded object-cover" />
                  ) : (
                    <div className="shrink-0 w-8 h-8 rounded" style={{ backgroundColor: '#E5E7EB' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-navy truncate">{l.name}</div>
                    {l.note.trim() && <div className="text-xs" style={{ color: '#9CA3AF' }}>{l.note.trim()}</div>}
                  </div>
                  <span className="text-sm font-bold shrink-0">×{l.qty}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>Mã PIN quản lý</div>
              <input type="password" inputMode="numeric" value={orderConfirmPin}
                onChange={e => setOrderConfirmPin(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmOrder(); }}
                placeholder="Mã PIN" autoFocus
                className="w-full text-center tracking-[0.3em] rounded-lg px-3 py-2.5 text-lg font-bold"
                style={{ border: '1px solid #D1D5DB' }} />
              {orderConfirmMsg && <div className="text-xs font-semibold mt-1.5" style={{ color: '#DC2626' }}>{orderConfirmMsg}</div>}
            </div>
            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>Đơn hàng này sẽ được tạo và xác nhận ngay trên Odoo — không thể huỷ trong app.</div>
            <div className="flex gap-2">
              <button onClick={() => { setOrderPendingConfirm(false); setOrderConfirmPin(''); setOrderConfirmMsg(null); }}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                Huỷ
              </button>
              <button onClick={confirmOrder} disabled={orderSubmitting || !orderConfirmPin.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2.5 text-white disabled:opacity-40" style={{ backgroundColor: '#16A34A' }}>
                {orderSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
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
