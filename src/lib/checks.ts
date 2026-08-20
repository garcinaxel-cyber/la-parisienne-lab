import type { SupabaseClient } from '@supabase/supabase-js';
import { runReconciliationCheck, type ReconciliationResult } from '@/lib/reconciliation';
import { syncStockToOdoo } from '@/lib/odoo-mo-sync';

// "Check" — Axel, 2026-08-20: one button, everything checks automatically, 7-day run-history
// (see lab_v46_check_and_blocked_tracking.sql). Reconciliation (lib/reconciliation.ts) already
// existed and keeps its own forward-looking window (yesterday..+6 days — it's about upcoming
// plannable production).
//
// The 3 checks below originally shared a trailing 7-day window (today-6..today). Axel, 2026-08-21:
// "ca devrait comparer seulement le jour j et le jour suivant" — narrowed to today + tomorrow.
// Rationale: these checks exist to catch drift on deliveries that are imminent (today, already
// in progress) or already published (tomorrow), so it can be fixed before the delivery happens —
// not to dig up a week-old discrepancy that's now moot. Run-history retention (7 days of past
// RUNS) is unrelated and unaffected — this only shrinks what EACH run compares.
//
// Day boundary in Vietnam local time (Asia/Ho_Chi_Minh) — same convention as the shop portal and
// delivery-check "today/tomorrow" picker elsewhere in the app. A naive UTC day would drift by the
// +7h offset right around VN midnight, when the morning cron runs.
function toDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function checkWindow(): { from: string; to: string } {
  const now = new Date();
  return { from: toDateStr(now), to: toDateStr(new Date(now.getTime() + 86400000)) };
}

// Supabase/PostgREST caps a single request at 1000 rows by default. With the old 7-day trailing
// window this silently truncated lab_order_lines/lab_delivery_check_lines and produced false
// "qty_drift" issues for whatever fell past row 1000 — confirmed live 2026-08-20: order
// REP/2026/01085 had a correct qty_expected=36 for BMCRCXBH in the DB, yet checkDeliveryCoverage
// reported expected_app=0, purely because that row didn't fit in the first page (1140 check-lines
// in a window sized for 1000). The narrower 2-day window above makes this unlikely to recur, but
// paginate anyway so a busy day can't silently reintroduce it.
async function fetchAllPages<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

// ── 1. Delivery-check coverage ──────────────────────────────────────────────
// Does every (order_ref, delivery_date, sku) that Odoo actually sent us have a matching,
// up-to-date line in lab_delivery_check_lines? Two distinct drift classes, both invisible
// today:
//  - not materialized: nobody (assistant or shop) has opened this order yet, so
//    ensureDeliveryOrderChecklist() never ran and lab_delivery_orders has no row at all.
//  - qty drift: the order WAS opened and a check line exists, but the Odoo quantity has since
//    changed (an order edit after the checklist was first built) — confirmed by reading
//    ensureDeliveryOrderChecklist(): it self-heals product_category/note on every open, but
//    NEVER re-syncs qty_expected on an existing line. That gap is real and undetected today.
// Deliberately read-only — no auto-repair, this only reports so an admin can decide.
export interface DeliveryCoverageIssue {
  kind: 'not_materialized' | 'qty_drift';
  date: string;
  order_ref: string;
  sku?: string;
  expected_odoo?: number;
  expected_app?: number;
}

export async function checkDeliveryCoverage(supabase: SupabaseClient, from: string, to: string): Promise<DeliveryCoverageIssue[]> {
  const { data: imports } = await supabase.from('lab_imports')
    .select('id, delivery_date').eq('status', 'published').gte('delivery_date', from).lte('delivery_date', to);
  const importIds = (imports ?? []).map((i: any) => i.id);

  const [orderLines, packagingLines, headers] = await Promise.all([
    importIds.length
      ? fetchAllPages<any>((f, t) => supabase.from('lab_order_lines')
          .select('order_ref, delivery_date, product_sku, qty').in('import_id', importIds).gt('qty', 0).range(f, t))
      : Promise.resolve([]),
    fetchAllPages<any>((f, t) => supabase.from('lab_order_packaging_lines')
      .select('order_ref, delivery_date, sku, qty').gte('delivery_date', from).lte('delivery_date', to).range(f, t)),
    fetchAllPages<any>((f, t) => supabase.from('lab_delivery_orders')
      .select('id, order_ref, delivery_date').gte('delivery_date', from).lte('delivery_date', to).range(f, t)),
  ]);

  const key = (orderRef: string, date: string) => `${orderRef}||${date}`;
  const rawBySku = new Map<string, Map<string, number>>();
  const addRaw = (orderRef: string, date: string, sku: string | null, qty: number | null) => {
    if (!sku || !qty) return;
    const k = key(orderRef, date);
    const m = rawBySku.get(k) ?? new Map<string, number>();
    m.set(sku, (m.get(sku) ?? 0) + qty);
    rawBySku.set(k, m);
  };
  for (const l of orderLines) addRaw(l.order_ref, l.delivery_date, l.product_sku, l.qty);
  for (const l of packagingLines) addRaw(l.order_ref, l.delivery_date, l.sku, l.qty);

  const headerByKey = new Map<string, string>();
  for (const h of headers) headerByKey.set(key(h.order_ref, h.delivery_date), h.id);
  const headerIds = Array.from(headerByKey.values());

  const checkLines = headerIds.length
    ? await fetchAllPages<any>((f, t) => supabase.from('lab_delivery_check_lines')
        .select('delivery_order_id, sku, qty_expected').in('delivery_order_id', headerIds).range(f, t))
    : [];
  const appByHeader = new Map<string, Map<string, number>>();
  for (const l of checkLines) {
    if (!l.sku) continue;
    const m = appByHeader.get(l.delivery_order_id) ?? new Map<string, number>();
    m.set(l.sku, (m.get(l.sku) ?? 0) + (l.qty_expected ?? 0));
    appByHeader.set(l.delivery_order_id, m);
  }

  const issues: DeliveryCoverageIssue[] = [];
  for (const [k, skuMap] of Array.from(rawBySku)) {
    const idx = k.lastIndexOf('||');
    const orderRef = k.slice(0, idx);
    const date = k.slice(idx + 2);
    const headerId = headerByKey.get(k);
    if (!headerId) { issues.push({ kind: 'not_materialized', date, order_ref: orderRef }); continue; }
    const appMap = appByHeader.get(headerId) ?? new Map<string, number>();
    for (const [sku, qty] of Array.from(skuMap)) {
      const appQty = appMap.get(sku) ?? 0;
      if (appQty !== qty) issues.push({ kind: 'qty_drift', date, order_ref: orderRef, sku, expected_odoo: qty, expected_app: appQty });
    }
  }
  return issues;
}

// ── 2. Production → Stock ───────────────────────────────────────────────────
// A card marked "done" (fully produced) whose qty_sent_total hasn't caught up to what was
// actually produced — physically made but not (fully) handed off to stock yet. Includes extra/
// buffer cards on purpose (unlike reconciliation, which excludes them) — an extra card still
// needs to physically reach stock like any other.
export interface ProductionStockIssue {
  date: string; team: string; product: string; produced: number; sent: number; gap: number;
  is_extra: boolean; card_id: string;
}

export async function checkProductionToStock(supabase: SupabaseClient, from: string, to: string): Promise<ProductionStockIssue[]> {
  const { data: imports } = await supabase.from('lab_imports')
    .select('id, delivery_date').eq('status', 'published').gte('delivery_date', from).lte('delivery_date', to);
  const importIds = (imports ?? []).map((i: any) => i.id);
  if (!importIds.length) return [];
  const dateByImport: Record<string, string> = {};
  for (const i of imports ?? []) dateByImport[i.id] = i.delivery_date;

  const { data: rows } = await supabase.from('lab_assignments')
    .select('id, team, product_name_vi, status, qty_produced, total_qty, qty_sent_total, cancelled, is_extra, import_id')
    .in('import_id', importIds).eq('status', 'done');

  const issues: ProductionStockIssue[] = [];
  for (const a of rows ?? []) {
    if (a.cancelled) continue;
    const produced = a.qty_produced || a.total_qty || 0;
    const sent = a.qty_sent_total || 0;
    if (sent < produced) {
      issues.push({
        date: dateByImport[a.import_id], team: a.team, product: a.product_name_vi,
        produced, sent, gap: produced - sent, is_extra: !!a.is_extra, card_id: a.id,
      });
    }
  }
  return issues;
}

// ── 3. Stock → Odoo ──────────────────────────────────────────────────────────
// Reuses syncStockToOdoo() in dry-run — it already computes exactly this comparison (sum sent
// to stock per SKU/day vs sum of Odoo MOs) for the real-time sync and the manual resync route;
// this just runs it read-only across the check window instead of one day, so drift shows up
// even if the real-time trigger silently failed on a given transfer.
export interface StockOdooIssue {
  date: string; kind: 'not_synced' | 'drifted' | 'no_odoo_product' | 'missing_sku' | 'error';
  sku?: string; product?: string; qty?: number; mo?: string; from?: number; to?: number; detail?: string;
}

export async function checkStockToOdoo(supabase: SupabaseClient, from: string, to: string): Promise<StockOdooIssue[]> {
  const dates: string[] = [];
  const cursor = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cursor <= end) { dates.push(toDateStr(cursor)); cursor.setUTCDate(cursor.getUTCDate() + 1); }

  const issues: StockOdooIssue[] = [];
  for (const date of dates) {
    let r;
    try { r = await syncStockToOdoo(supabase, date, { commit: false }); }
    catch (e: any) { issues.push({ date, kind: 'error', detail: String(e?.message ?? e) }); continue; }
    for (const c of r.toCreate) issues.push({ date, kind: 'not_synced', sku: c.sku, product: c.product, qty: c.qty });
    for (const u of r.toUpdate) issues.push({ date, kind: 'drifted', sku: u.sku, product: u.product, mo: u.mo, from: u.from, to: u.to });
    for (const n of r.noProduct) issues.push({ date, kind: 'no_odoo_product', sku: n.sku, qty: n.qty });
    for (const m of r.missingSku) issues.push({ date, kind: 'missing_sku', product: m.productName, qty: m.qty });
  }
  return issues;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export interface AllChecksResult {
  reconciliation: ReconciliationResult;
  checkRangeFrom: string;
  checkRangeTo: string;
  deliveryCoverage: DeliveryCoverageIssue[];
  productionStock: ProductionStockIssue[];
  stockOdoo: StockOdooIssue[];
}

export async function runAllChecks(supabase: SupabaseClient): Promise<AllChecksResult> {
  const { from, to } = checkWindow();
  const [reconciliation, deliveryCoverage, productionStock, stockOdoo] = await Promise.all([
    runReconciliationCheck(supabase),
    checkDeliveryCoverage(supabase, from, to),
    checkProductionToStock(supabase, from, to),
    checkStockToOdoo(supabase, from, to),
  ]);
  return { reconciliation, checkRangeFrom: from, checkRangeTo: to, deliveryCoverage, productionStock, stockOdoo };
}
