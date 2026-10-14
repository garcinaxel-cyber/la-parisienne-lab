// Shop reception gaps (Axel, 2026-10-13 — PREVIEW branch, decisions in
// claude/shop-reception-gaps-decisions-2026-10-13.md).
//
// A gap = what the shop confirmed vs what the Lab assistants CHECKED at departure (qty_checked,
// the "Bếp" column — an intentional extra checked by the Lab is therefore not a gap):
//   missing  = max(0, sent − received)
//   extra    = max(0, received − sent)
//   damaged  = received units that arrived broken (lab_shop_receipt_lines.qty_damaged) → Lab loss
//
// Zero operational impact: gaps are COMPUTED from the existing receipts, read-only. Persisting
// the Lab's decisions needs migration lab_v121 (2 new tables + 2 nullable columns). Until it is
// applied, every write here returns { error: 'not_enabled' } and nothing is stored.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '@/lib/fetch-all-pages';
import { normShopName } from '@/lib/delivery-check';
import { planGapResolution, executeReceptionPlan, receptionOdooMode, finalizeSalesOrderGaps, finalizeReplenishmentGaps, type RepGapLine, type GapKind, type LabCause, type ReceptionPlan, type SoGapLine, type SoFinalizeResult } from '@/lib/reception-odoo';

export type { GapKind, LabCause };
export type GapStatus = 'open' | 'waiting_shop' | 'waiting_return' | 'closed';

export const GAP_DEADLINE_HOURS = 48;
export const DAMAGED_RETURN_MAX_DELIVERIES = 2;
const WINDOW_DAYS = 14;
const GAPS_FROM = '2026-10-14'; // Axel 14/10: 13/10 deliveries were before the process existed — handled by hand

export type DeliveryGap = {
  id: string | null; // lab_delivery_gaps row id once persisted
  key: string; sourceType: 'replenishment' | 'sales_order'; checkLineId: string; deliveryOrderId: string; orderRef: string; deliveryDate: string; shopName: string;
  sku: string | null; product: string; kind: GapKind; qty: number;
  sent: number; received: number; damaged: number;
  shopCause: string | null; shopNote: string | null; confirmedBy: string | null; confirmedAt: string | null;
  checkedBy: string | null; checkedAt: string | null;
  status: GapStatus; labCause: LabCause | null; labMessage: string | null; decidedBy: string | null; decidedAt: string | null;
  returnConfirmedAt: string | null; returnConfirmedBy: string | null;
  deadlineAt: string | null; overdue: boolean; deliveriesSince: number; returnOverdue: boolean;
  persisted: boolean; odooLog: any[]; odooMode: string | null; photoUrls: string[];
};

// ── Schema detection (cached per lambda for a minute) ──────────────────────────────────────
let schemaCache: { ready: boolean; at: number } | null = null;
export async function gapsSchemaReady(sb: SupabaseClient): Promise<boolean> {
  if (schemaCache && Date.now() - schemaCache.at < 60_000) return schemaCache.ready;
  const { error } = await sb.from('lab_delivery_gaps').select('id').limit(1);
  const ready = !error;
  schemaCache = { ready, at: Date.now() };
  return ready;
}

function vnToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

export function computeLineGaps(
  line: { qty_checked: number | null; qty_expected: number },
  receipt: { qty_received: number | null; qty_damaged?: number | null } | null,
): { kind: GapKind; qty: number }[] {
  if (!receipt || receipt.qty_received == null) return [];
  const sent = Number(line.qty_checked ?? line.qty_expected);
  const received = Number(receipt.qty_received);
  const damaged = Math.max(0, Math.min(Number(receipt.qty_damaged ?? 0), received));
  const out: { kind: GapKind; qty: number }[] = [];
  if (sent > received) out.push({ kind: 'missing', qty: sent - received });
  if (received > sent) out.push({ kind: 'extra', qty: received - sent });
  if (damaged > 0) out.push({ kind: 'damaged', qty: damaged });
  return out;
}

// Axel 2026-10-14: "si ils mettent la photo en preuve de perte … rendre automatique le retour +
// scrap". A damaged line always carries the shop's photo (required in the shop app), so it is
// settled automatically as a Lab loss and goes straight to "Gửi Odoo". The assistant can still
// contest it from the gaps tab (photo doesn't show damage → shop recounts). The physical return
// in Nhập kho (LỖI LAB) is optional now — a bonus, tracked but no longer blocking.
export const AUTO_DAMAGED_BY = 'Tự động (ảnh)';
function defaultStatus(_kind: GapKind): GapStatus {
  return 'open';
}
function autoSettled(kind: GapKind, receipt: any): boolean {
  return kind === 'damaged' && Array.isArray(receipt?.photo_urls) && receipt.photo_urls.length > 0;
}

// ── Listing ────────────────────────────────────────────────────────────────────────────────
export async function listDeliveryGaps(
  sb: SupabaseClient,
  opts: { shopName?: string; days?: number; checkLineIds?: string[] } = {},
): Promise<{ gaps: DeliveryGap[]; schemaReady: boolean }> {
  const schemaReady = await gapsSchemaReady(sb);
  const today = vnToday();
  // Backlog up to 12/10 was cleaned up by hand in Odoo (claude/shop-in-backlog-check-2026-10-12.md),
  // so gaps start on 13/10 — older ones would show as "to decide" although already settled.
  const rolling = addDays(today, -(opts.days ?? WINDOW_DAYS));
  const from = rolling > GAPS_FROM ? rolling : GAPS_FROM;
  const target = opts.shopName ? normShopName(opts.shopName) : null;

  const headers = (await fetchAllPages<{ id: string; delivery_date: string; order_ref: string; shop_name: string | null; marked_not_delivered: boolean | null; source_type: string | null }>((f, t) =>
    sb.from('lab_delivery_orders').select('id, delivery_date, order_ref, shop_name, marked_not_delivered, source_type')
      .eq('status', 'validated').gte('delivery_date', from).order('id').range(f, t)))
    .filter(h => !h.marked_not_delivered && h.shop_name && (!target || normShopName(h.shop_name) === target));
  if (!headers.length) return { gaps: [], schemaReady };
  const headerById = new Map(headers.map(h => [h.id, h]));

  // Receipts first (select * so qty_damaged / gap_cause come back once v121 exists, and the
  // query still works before it does), then only the check lines that have a receipt.
  const ids = headers.map(h => h.id);
  const receipts: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    receipts.push(...await fetchAllPages<any>((f, t) =>
      sb.from('lab_shop_receipt_lines').select('*').in('delivery_order_id', chunk).not('qty_received', 'is', null).order('check_line_id').range(f, t)));
  }
  const lineIds = receipts.map(r => r.check_line_id as string).filter(id => !opts.checkLineIds || opts.checkLineIds.includes(id));
  if (!lineIds.length) return { gaps: [], schemaReady };
  const lines: any[] = [];
  for (let i = 0; i < lineIds.length; i += 200) {
    const { data } = await sb.from('lab_delivery_check_lines')
      .select('id, delivery_order_id, sku, product_name_vi, qty_expected, qty_checked, checked_by_name, checked_at')
      .in('id', lineIds.slice(i, i + 200));
    lines.push(...(data ?? []));
  }
  const lineById = new Map(lines.map(l => [l.id as string, l]));

  const persisted = new Map<string, any>();
  if (schemaReady) {
    for (let i = 0; i < lineIds.length; i += 200) {
      const { data } = await sb.from('lab_delivery_gaps').select('*').in('check_line_id', lineIds.slice(i, i + 200));
      for (const g of data ?? []) persisted.set(`${g.check_line_id}:${g.kind}`, g);
    }
  }

  // Deliveries to the same shop after a given date — for the "not returned after 2 deliveries" rule.
  const datesByShop = new Map<string, string[]>();
  for (const h of headers) {
    const k = normShopName(h.shop_name);
    const arr = datesByShop.get(k) ?? [];
    if (!arr.includes(h.delivery_date)) arr.push(h.delivery_date);
    datesByShop.set(k, arr);
  }

  const now = Date.now();
  const gaps: DeliveryGap[] = [];
  for (const r of receipts) {
    const l = lineById.get(r.check_line_id);
    const h = headerById.get(r.delivery_order_id);
    if (!l || !h) continue;
    const sent = Number(l.qty_checked ?? l.qty_expected);
    const received = Number(r.qty_received);
    const damaged = Math.max(0, Math.min(Number(r.qty_damaged ?? 0), received));
    for (const g of computeLineGaps(l, r)) {
      const key = `${l.id}:${g.kind}`;
      const p = persisted.get(key);
      const auto = !p && autoSettled(g.kind, r);
      const status: GapStatus = p?.status ?? (auto ? 'closed' : defaultStatus(g.kind));
      const labCause: LabCause | null = p?.lab_cause ?? (auto ? 'damaged_returned' : null);
      const deadlineAt = r.confirmed_at ? new Date(new Date(r.confirmed_at).getTime() + GAP_DEADLINE_HOURS * 3600_000).toISOString() : null;
      const deliveriesSince = (datesByShop.get(normShopName(h.shop_name)) ?? []).filter(d => d > h.delivery_date).length;
      const awaitingReturn = (g.kind === 'damaged' || labCause === 'damaged_returned') && status !== 'waiting_shop' && !p?.return_confirmed_at;
      gaps.push({
        id: p?.id ?? null, key, sourceType: h.source_type === 'sales_order' ? 'sales_order' : 'replenishment', checkLineId: l.id, deliveryOrderId: h.id, orderRef: h.order_ref, deliveryDate: h.delivery_date, shopName: h.shop_name!,
        sku: l.sku, product: l.product_name_vi, kind: g.kind, qty: g.qty, sent, received, damaged,
        shopCause: r.gap_cause ?? null, shopNote: r.note ?? null, confirmedBy: r.confirmed_by_name ?? null, confirmedAt: r.confirmed_at ?? null,
        checkedBy: l.checked_by_name ?? null, checkedAt: l.checked_at ?? null,
        status, labCause, labMessage: p?.lab_message ?? null, decidedBy: p?.decided_by_name ?? (auto ? AUTO_DAMAGED_BY : null), decidedAt: p?.decided_at ?? null,
        returnConfirmedAt: p?.return_confirmed_at ?? null, returnConfirmedBy: p?.return_confirmed_by_name ?? null,
        deadlineAt, overdue: status === 'open' && !!deadlineAt && now > new Date(deadlineAt).getTime(),
        deliveriesSince, returnOverdue: awaitingReturn && deliveriesSince >= DAMAGED_RETURN_MAX_DELIVERIES,
        persisted: !!p, odooLog: p?.odoo_log ?? [], odooMode: p?.odoo_mode ?? null, photoUrls: r.photo_urls ?? [],
      });
    }
  }
  gaps.sort((a, b) => (a.deadlineAt ?? '').localeCompare(b.deadlineAt ?? '') || a.product.localeCompare(b.product));
  return { gaps, schemaReady };
}

// ── Writes (need lab_v121) ─────────────────────────────────────────────────────────────────
async function logRun(sb: SupabaseClient, row: { delivery_order_id: string; gap_id?: string | null; order_ref: string; action: string; plan: ReceptionPlan; by: string | null }) {
  await sb.from('lab_reception_odoo_runs').insert({
    delivery_order_id: row.delivery_order_id, gap_id: row.gap_id ?? null, order_ref: row.order_ref, action: row.action,
    mode: row.plan.mode, ok: row.plan.ok, plan: { steps: row.plan.steps }, error: row.plan.error ?? null, created_by_name: row.by,
  });
}

// Called after every shop confirm. A recount re-evaluates the line: a gap that disappeared is
// closed, one that is still there goes back to "open" for the Lab (decided cause cleared).
export async function syncGapsForLine(sb: SupabaseClient, checkLineId: string): Promise<void> {
  if (!(await gapsSchemaReady(sb))) return;
  const { data: line } = await sb.from('lab_delivery_check_lines')
    .select('id, delivery_order_id, sku, product_name_vi, qty_expected, qty_checked').eq('id', checkLineId).maybeSingle();
  if (!line) return;
  const [{ data: header }, { data: receipt }, { data: existing }] = await Promise.all([
    sb.from('lab_delivery_orders').select('id, order_ref, delivery_date, shop_name').eq('id', line.delivery_order_id).maybeSingle(),
    sb.from('lab_shop_receipt_lines').select('*').eq('check_line_id', checkLineId).maybeSingle(),
    sb.from('lab_delivery_gaps').select('*').eq('check_line_id', checkLineId),
  ]);
  if (!header) return;
  const now = new Date().toISOString();
  const computed = computeLineGaps(line, receipt);
  const byKind = new Map((existing ?? []).map((g: any) => [g.kind as GapKind, g]));
  for (const kind of ['missing', 'extra', 'damaged'] as GapKind[]) {
    const c = computed.find(x => x.kind === kind);
    const prev = byKind.get(kind);
    if (c) {
      const unchanged = prev && Number(prev.qty) === c.qty && prev.status !== 'waiting_shop';
      await sb.from('lab_delivery_gaps').upsert({
        check_line_id: checkLineId, delivery_order_id: header.id, order_ref: header.order_ref, delivery_date: header.delivery_date,
        shop_name: header.shop_name, sku: line.sku, product_name: line.product_name_vi, kind, qty: c.qty,
        ref_qty: line.qty_checked ?? line.qty_expected, received_qty: receipt?.qty_received ?? null,
        shop_cause: kind === 'damaged' ? null : (receipt?.gap_cause ?? null), shop_note: receipt?.note ?? null,
        ...(unchanged ? {} : autoSettled(kind, receipt)
          ? { status: 'closed', lab_cause: 'damaged_returned', decided_at: now, decided_by_name: AUTO_DAMAGED_BY, closed_at: now }
          : { status: defaultStatus(kind), lab_cause: null, decided_at: null, decided_by_name: null, closed_at: null }),
        updated_at: now,
      }, { onConflict: 'check_line_id,kind' });
    } else if (prev && prev.status !== 'closed') {
      await sb.from('lab_delivery_gaps').update({ status: 'closed', closed_at: now, updated_at: now, qty: 0 }).eq('id', prev.id);
    }
  }
}

const STATUS_AFTER: Record<LabCause, GapStatus> = {
  found_at_lab: 'closed', damaged_returned: 'closed', lost_transport: 'closed',
  shop_miscount: 'waiting_shop', lab_sent_extra: 'closed',
};
const CAUSES_BY_KIND: Record<GapKind, LabCause[]> = {
  missing: ['found_at_lab', 'damaged_returned', 'lost_transport', 'shop_miscount'],
  extra: ['lab_sent_extra', 'shop_miscount'],
  damaged: ['damaged_returned', 'shop_miscount'],
};

export async function decideGap(sb: SupabaseClient, input: {
  checkLineId: string; kind: GapKind; cause: LabCause; message: string | null; byName: string;
}): Promise<{ ok?: boolean; plan?: ReceptionPlan; error?: string }> {
  if (!CAUSES_BY_KIND[input.kind].includes(input.cause)) return { error: 'Cause not allowed for this gap' };
  if (!(await gapsSchemaReady(sb))) return { error: 'not_enabled' };
  await syncGapsForLine(sb, input.checkLineId); // make sure the row exists and is current
  const { data: g } = await sb.from('lab_delivery_gaps').select('*').eq('check_line_id', input.checkLineId).eq('kind', input.kind).maybeSingle();
  if (!g) return { error: 'Gap not found' };
  if (g.odoo_mode === 'sent') return { error: 'Already sent to Odoo' };
  const { data: hdr } = await sb.from('lab_delivery_orders').select('source_type').eq('id', g.delivery_order_id).maybeSingle();
  const plan = await executeReceptionPlan(planGapResolution({ kind: input.kind, qty: Number(g.qty), sku: g.sku, product: g.product_name, shop: g.shop_name, sourceType: hdr?.source_type }, input.cause));
  const now = new Date().toISOString();
  const status = STATUS_AFTER[input.cause];
  const { error } = await sb.from('lab_delivery_gaps').update({
    lab_cause: input.cause, lab_message: input.message?.slice(0, 300) ?? null, decided_by_name: input.byName, decided_at: now,
    status, closed_at: status === 'closed' ? now : null, odoo_mode: plan.mode,
    odoo_log: [...(g.odoo_log ?? []), { at: now, by: input.byName, cause: input.cause, mode: plan.mode, ok: plan.ok, steps: plan.steps, error: plan.error ?? null }],
    updated_at: now,
  }).eq('id', g.id);
  if (error) return { error: error.message };
  await logRun(sb, { delivery_order_id: g.delivery_order_id, gap_id: g.id, order_ref: g.order_ref, action: 'resolve_gap', plan, by: input.byName });
  return { ok: true, plan };
}

// Optional since 2026-10-14 (photo = proof): the Lab records that the broken units are
// physically back (Stock reception, LỖI LAB tag). No Odoo effect and no status change — the
// return + scrap are done by "Gửi Odoo"; this only clears the "not returned" reminder.
export async function confirmDamagedReturn(sb: SupabaseClient, input: { gapId: string; qty: number; byName: string }): Promise<{ ok?: boolean; error?: string }> {
  if (!(await gapsSchemaReady(sb))) return { error: 'not_enabled' };
  const { data: g } = await sb.from('lab_delivery_gaps').select('*').eq('id', input.gapId).maybeSingle();
  if (!g || g.return_confirmed_at || !(g.kind === 'damaged' || g.lab_cause === 'damaged_returned')) return { error: 'Nothing to confirm' };
  const qty = Math.max(0, Math.min(input.qty, Number(g.qty)));
  const now = new Date().toISOString();
  const { error } = await sb.from('lab_delivery_gaps').update({
    return_confirmed_qty: qty, return_confirmed_by_name: input.byName, return_confirmed_at: now,
    odoo_log: [...(g.odoo_log ?? []), { at: now, by: input.byName, cause: 'returned_to_lab', note: 'physical return confirmed (no Odoo effect)' }],
    updated_at: now,
  }).eq('id', g.id);
  if (error) return { error: error.message };
  return { ok: true };
}

export { receptionOdooMode };

// ── Second validation: one "Gửi Odoo xác nhận cuối" per order (Axel, 2026-10-14) ───────────
// Step 1 = the assistants settle every gap of the order line by line (damaged lines with a photo
// are settled automatically). Step 2 = one button sends the whole order to Odoo:
//   sales order  → one return + Lab scrap + extra delivery + invoice back to draft, qty adjusted
//   replenishment → shop IN at good qty + transit→LAB (+ scrap) / transit scrap / LAB→shop
// Ready only when every gap line of the order is settled ('closed').
type SendAction = SoGapLine['action'] | RepGapLine['action'];
function soAction(g: DeliveryGap): SoGapLine['action'] | null {
  if (g.kind === 'damaged') return g.labCause === 'shop_miscount' ? null : 'return_scrap';
  if (g.kind === 'extra') return g.labCause === 'lab_sent_extra' ? 'extra' : null;
  if (g.labCause === 'found_at_lab') return 'return';
  if (g.labCause === 'damaged_returned' || g.labCause === 'lost_transport') return 'return_scrap';
  return null;
}
function repAction(g: DeliveryGap): RepGapLine['action'] | null {
  if (g.kind === 'damaged') return g.labCause === 'shop_miscount' ? null : 'transit_to_lab_scrap';
  if (g.kind === 'extra') return g.labCause === 'lab_sent_extra' ? 'lab_to_shop' : null;
  if (g.labCause === 'found_at_lab') return 'transit_to_lab';
  if (g.labCause === 'damaged_returned') return 'transit_to_lab_scrap';
  if (g.labCause === 'lost_transport') return 'scrap_transit';
  return null;
}

export type OrderSendState = {
  orderRef: string; sourceType: string; ready: boolean; sent: boolean;
  odooRefs: { at: string; by: string | null; done: string[] }[]; // what each live send did in Odoo
  lines: { key: string; product: string; sku: string | null; kind: GapKind; qty: number; status: GapStatus; labCause: string | null; action: SendAction | null; sent: boolean; photoUrls: string[] }[];
};

export async function orderSendState(sb: SupabaseClient, deliveryOrderId: string): Promise<OrderSendState | { error: string }> {
  const { data: h } = await sb.from('lab_delivery_orders').select('order_ref, source_type').eq('id', deliveryOrderId).maybeSingle();
  if (!h) return { error: 'Order not found' };
  const isSo = h.source_type === 'sales_order';
  const { gaps } = await listDeliveryGaps(sb);
  const mine = gaps.filter(g => g.deliveryOrderId === deliveryOrderId);
  const lines = mine.map(g => ({ key: g.key, product: g.product, sku: g.sku, kind: g.kind, qty: g.qty, status: g.status, labCause: g.labCause, action: isSo ? soAction(g) : repAction(g), sent: g.odooMode === 'sent', photoUrls: g.photoUrls }));
  const toSend = lines.filter(l => l.action && !l.sent);
  const { data: runs } = await sb.from('lab_reception_odoo_runs').select('created_at, created_by_name, plan')
    .eq('delivery_order_id', deliveryOrderId).in('action', ['rep_finalize', 'so_finalize']).eq('mode', 'live').eq('ok', true).order('created_at');
  return {
    orderRef: h.order_ref, sourceType: h.source_type,
    odooRefs: (runs ?? []).map((r: any) => ({ at: r.created_at, by: r.created_by_name ?? null, done: (r.plan?.done ?? []) as string[] })),
    ready: lines.length > 0 && lines.every(l => l.status === 'closed') && toSend.length > 0,
    sent: lines.length > 0 && toSend.length === 0 && lines.every(l => l.status === 'closed'),
    lines,
  };
}

async function receptionLinesOf(sb: SupabaseClient, deliveryOrderId: string) {
  const [{ data: lines }, { data: receipts }] = await Promise.all([
    sb.from('lab_delivery_check_lines').select('id, sku, qty_expected, qty_checked').eq('delivery_order_id', deliveryOrderId),
    sb.from('lab_shop_receipt_lines').select('*').eq('delivery_order_id', deliveryOrderId),
  ]);
  const rBy = new Map((receipts ?? []).map((r: any) => [r.check_line_id, r]));
  return (lines ?? []).map((l: any) => {
    const r: any = rBy.get(l.id);
    const sent = Number(l.qty_checked ?? l.qty_expected);
    const received = r?.qty_received == null ? sent : Number(r.qty_received);
    return { sku: l.sku as string | null, sent, received, damaged: Math.max(0, Math.min(Number(r?.qty_damaged ?? 0), received)) };
  });
}

export async function sendOrderToOdoo(sb: SupabaseClient, deliveryOrderId: string, byName: string): Promise<{ result?: SoFinalizeResult; error?: string }> {
  const st = await orderSendState(sb, deliveryOrderId);
  if ('error' in st) return { error: st.error };
  if (!st.ready) return { error: 'Every gap line must be settled first' };
  const toSend = st.lines.filter(l => l.action && !l.sent && l.sku);
  const isSo = st.sourceType === 'sales_order';
  const result = isSo
    ? await finalizeSalesOrderGaps(st.orderRef, toSend.map(l => ({ sku: l.sku as string, qty: l.qty, action: l.action as SoGapLine['action'] })))
    : await finalizeReplenishmentGaps(st.orderRef, toSend.map(l => ({ sku: l.sku as string, qty: l.qty, action: l.action as RepGapLine['action'] })), await receptionLinesOf(sb, deliveryOrderId));
  const now = new Date().toISOString();
  await sb.from('lab_reception_odoo_runs').insert({
    delivery_order_id: deliveryOrderId, order_ref: st.orderRef, action: isSo ? 'so_finalize' : 'rep_finalize', mode: result.live ? 'live' : 'simulated',
    ok: result.ok, plan: { lines: toSend, done: result.done }, error: result.error ?? null, created_by_name: byName,
  });
  if (result.ok && result.live) {
    for (const l of toSend) {
      const [checkLineId, kind] = l.key.split(':');
      await sb.from('lab_delivery_gaps').update({ odoo_mode: 'sent', updated_at: now }).eq('check_line_id', checkLineId).eq('kind', kind);
    }
  }
  return { result };
}
