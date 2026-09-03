import type { SupabaseClient } from '@supabase/supabase-js';
import { runReconciliationCheck, type ReconciliationResult } from '@/lib/reconciliation';
import { syncStockToOdoo } from '@/lib/odoo-mo-sync';
import { fetchAllPages } from '@/lib/fetch-all-pages';
import { odooExecute, odooConfigured, labTodayUtcThreshold } from '@/lib/odoo';
import { SYNC_GRACE_DAYS, ODOO_FETCH_CAPS } from '@/lib/odoo-sync';
import { getLabStockAllQuants } from '@/lib/odoo-inventory';

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
// paginate anyway so a busy day can't silently reintroduce it. The helper now lives in
// lib/fetch-all-pages.ts (2026-09-01) so reconciliation.ts can share it instead of carrying its
// own unpaginated copy of the same two queries.

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

// ── 5. Odoo fetch volume vs the sync's hardcoded caps ────────────────────────
// runOdooSync (odoo-sync.ts) reads Odoo with fixed search_read limits (ODOO_FETCH_CAPS). Past a
// cap Odoo silently returns a partial page -- orders would vanish from the sync with no error,
// exactly the PostgREST 1000-row story again but on the source of truth. Measured here with
// the SAME domains/threshold as the sync, via `search` (ids only, no limit) + `search_count`,
// so every Check run records the fill level and the UI can warn before the cliff.
export type OdooVolumeGauge = { count: number; cap: number };
export type OdooVolume =
  | { sales: OdooVolumeGauge; sales_lines: OdooVolumeGauge; repl: OdooVolumeGauge; repl_lines: OdooVolumeGauge; measured_at: string }
  | { error: string; measured_at: string };

export async function measureOdooFetchVolume(): Promise<OdooVolume> {
  const measured_at = new Date().toISOString();
  if (!odooConfigured()) return { error: 'odoo not configured', measured_at };
  try {
    const threshold = labTodayUtcThreshold(SYNC_GRACE_DAYS);
    const salesIds: number[] = await odooExecute('sale.order', 'search',
      [[['state', 'in', ['draft', 'sent', 'sale']], ['commitment_date', '>=', threshold]]]);
    const replIds: number[] = await odooExecute('stock.replenishment.request', 'search',
      [[['state', 'in', ['draft', 'submitted', 'approved']], ['delivery_date', '>=', threshold]]]);
    const [salesLines, replLines] = await Promise.all([
      salesIds.length ? odooExecute<number>('sale.order.line', 'search_count', [[['order_id', 'in', salesIds]]]) : Promise.resolve(0),
      replIds.length ? odooExecute<number>('stock.replenishment.request.line', 'search_count', [[['request_id', 'in', replIds]]]) : Promise.resolve(0),
    ]);
    return {
      sales: { count: salesIds.length, cap: ODOO_FETCH_CAPS.sales },
      sales_lines: { count: salesLines, cap: ODOO_FETCH_CAPS.sales_lines },
      repl: { count: replIds.length, cap: ODOO_FETCH_CAPS.repl },
      repl_lines: { count: replLines, cap: ODOO_FETCH_CAPS.repl_lines },
      measured_at,
    };
  } catch (e: any) {
    return { error: String(e?.message ?? e), measured_at };
  }
}

// ── 6. Livraisons non bouclées — 7 jours glissants (Axel, 2026-09-02) ────────
// "le total des commandes qui n'ont pas la delivery sur Odoo, donc pas faites sur le delivery
// check par définition". Source = la demande importée (lab_order_lines, published), PAS
// lab_delivery_orders seul — une commande jamais ouverte n'a aucune ligne là-bas et serait
// invisible. 7 jours en arrière maximum, exprès : ne pas accumuler l'époque où le process
// n'était pas rodé. Une commande du jour n'est pas "en retard" tant que son jour n'est pas fini.

// Vérification Odoo partagée (Axel, 2026-09-03 : "attention, il se peut qu'elle soit faite sur
// Odoo mais pas sur l'app") — réutilisée par checkLateDeliveries ET par la page opérationnelle
// /delivery-check (isOrderDone ne connaissait QUE le statut app, jamais Odoo directement : une
// commande traitée sur Odoo en direct, sans jamais passer par l'app, restait "en retard" pour
// toujours, sans aucun signal). "Fait" = TOUS les pickings liés sont 'done' ou 'cancel', ET au
// moins un est réellement 'done' — pas juste "au moins un picking done" (bug trouvé le 09-03 :
// REP/2026/01284 avait un picking partiel 'done' + son reliquat/backorder encore en attente,
// donc PAS réellement livré, mais l'ancienne logique "any done" le marquait à tort comme fait).
export async function crossCheckOdooDone(refs: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  if (!refs.length || !odooConfigured()) return result;
  try {
    const repRefs = refs.filter(r => r.startsWith('REP'));
    const soRefs = refs.filter(r => !r.startsWith('REP'));
    const pickingIdsByRef: Record<string, number[]> = {};
    if (repRefs.length) {
      const reps = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
        [[['name', 'in', repRefs]]], { fields: ['name', 'delivery_picking_ids'] });
      for (const r of reps) pickingIdsByRef[r.name] = r.delivery_picking_ids ?? [];
    }
    if (soRefs.length) {
      const sos = await odooExecute<any[]>('sale.order', 'search_read',
        [[['name', 'in', soRefs]]], { fields: ['name', 'picking_ids'] });
      for (const s of sos) pickingIdsByRef[s.name] = s.picking_ids ?? [];
    }
    const allPids = Array.from(new Set(Object.values(pickingIdsByRef).flat())) as number[];
    const pickings = allPids.length
      ? await odooExecute<any[]>('stock.picking', 'read', [allPids], { fields: ['state'] })
      : [];
    const stateById: Record<number, string> = {};
    for (const pk of pickings) stateById[pk.id] = pk.state;
    for (const ref of refs) {
      const pids = pickingIdsByRef[ref] ?? [];
      result[ref] = pids.length > 0
        && pids.every(id => stateById[id] === 'done' || stateById[id] === 'cancel')
        && pids.some(id => stateById[id] === 'done');
    }
  } catch { /* best-effort — jamais fatal pour l'appelant */ }
  return result;
}

export interface LateDeliveryIssue {
  date: string; order_ref: string; shop: string | null;
  kind: 'never_opened' | 'not_validated' | 'not_pushed';
  push_error?: string | null;
  // Vérifié en direct contre Odoo (Axel, 2026-09-03 : "attention, il se peut qu'elle soit
  // faite sur Odoo mais pas sur l'app") : le picking Odoo est déjà 'done' → la livraison a eu
  // lieu, seul le traçage app manque. Affichée à part, HORS compteur d'alerte.
  doneOnOdoo?: boolean;
}

export async function checkLateDeliveries(supabase: SupabaseClient): Promise<LateDeliveryIssue[]> {
  const now = new Date();
  const from = toDateStr(new Date(now.getTime() - 7 * 86400000));
  const to = toDateStr(new Date(now.getTime() - 86400000)); // yesterday (VN)
  const demandRows = await fetchAllPages<any>((f, t) => supabase.from('lab_order_lines')
    .select('order_ref, delivery_date, shop_name')
    .gte('delivery_date', from).lte('delivery_date', to)
    .gt('qty', 0).eq('published', true).not('order_ref', 'is', null)
    .order('id').range(f, t));
  const orders = new Map<string, { date: string; ref: string; shop: string | null }>();
  for (const r of demandRows) {
    const key = `${r.delivery_date}|${r.order_ref}`;
    if (!orders.has(key)) orders.set(key, { date: r.delivery_date, ref: r.order_ref, shop: r.shop_name ?? null });
  }
  if (!orders.size) return [];
  const { data: dcos } = await supabase.from('lab_delivery_orders')
    .select('order_ref, delivery_date, status, odoo_push_status, odoo_push_error')
    .gte('delivery_date', from).lte('delivery_date', to);
  const dcoByKey: Record<string, any> = {};
  for (const d of dcos ?? []) dcoByKey[`${d.delivery_date}|${d.order_ref}`] = d;
  const issues: LateDeliveryIssue[] = [];
  for (const o of Array.from(orders.values())) {
    const d = dcoByKey[`${o.date}|${o.ref}`];
    if (!d) { issues.push({ date: o.date, order_ref: o.ref, shop: o.shop, kind: 'never_opened' }); continue; }
    if (d.status !== 'validated') { issues.push({ date: o.date, order_ref: o.ref, shop: o.shop, kind: 'not_validated' }); continue; }
    if (d.odoo_push_status !== 'validated' && d.odoo_push_status !== 'already_done') {
      issues.push({ date: o.date, order_ref: o.ref, shop: o.shop, kind: 'not_pushed', push_error: d.odoo_push_error ?? null });
    }
  }
  // Vérification best-effort contre Odoo, scopée aux seules commandes signalées.
  if (issues.length) {
    const doneByRef = await crossCheckOdooDone(issues.map(i => i.order_ref));
    for (const iss of issues) if (doneByRef[iss.order_ref]) iss.doneOnOdoo = true;
  }
  return issues.sort((a, b) => b.date.localeCompare(a.date) || a.order_ref.localeCompare(b.order_ref));
}

// ── 7. Snapshot stock LAB partagé + checks stock (Axel, 2026-09-02) ──────────
// UNE lecture Odoo large par run (getLabStockAllQuants: 2 appels RPC), partagée par le check
// "seuil de sécurité", le check "stock résiduel MTO" ET les vues stock de /analytics (qui
// lisent le snapshot stocké du dernier run au lieu de rappeler Odoo à chaque ouverture).
// Modèle métier (Axel) : seules 3 catégories se stockent dans la durée ; tout le reste est
// made-to-order — son stock doit être 0 ou expliqué par un envoi en attente de livraison. Un
// stock NÉGATIF transitoire est normal (livraison validée avant l'envoi en stock — Odoo sort
// le stock à la delivery, l'entrée arrive après) ; un négatif SANS envoi récent = production
// jamais envoyée en stock, donc jamais produite côté Odoo.
export const STOCK_CATEGORIES = ['Macaron', 'Biscuit Voyage', 'Tiramisu'];

export type StockSnapshotItem = { sku: string; name: string; qty: number; category: string | null };
export type StockSnapshot = { at: string; items: StockSnapshotItem[]; error?: string };

export async function collectLabStockSnapshot(supabase: SupabaseClient): Promise<StockSnapshot> {
  const at = new Date().toISOString();
  if (!odooConfigured()) return { at, items: [], error: 'odoo not configured' };
  try {
    const [quants, { data: variants }, { data: fiches }] = await Promise.all([
      getLabStockAllQuants(),
      supabase.from('lab_fiche_variants').select('sku, fiche_id').not('sku', 'is', null).limit(3000),
      supabase.from('lab_fiche_meta').select('id, category'),
    ]);
    const catByFiche: Record<string, string | null> = {};
    for (const f of fiches ?? []) catByFiche[f.id] = f.category ?? null;
    const catBySku: Record<string, string | null> = {};
    for (const v of variants ?? []) if (v.sku && !(v.sku in catBySku)) catBySku[v.sku] = catByFiche[v.fiche_id] ?? null;
    const bySku: Record<string, { name: string; qty: number }> = {};
    for (const q of quants) bySku[q.sku] = { name: q.name, qty: q.qty };
    // Catalogued finished goods only (SKU known to the fiche system): every 3-stock-category SKU
    // (even at 0 — the safety check needs those), plus any other catalogued SKU with a non-zero
    // LAB quantity (the made-to-order coherence set). Raw materials / semi-finished quants are
    // dropped here — they have no fiche.
    const items: StockSnapshotItem[] = [];
    for (const [sku, category] of Object.entries(catBySku)) {
      const q = bySku[sku];
      const isStockCat = !!category && STOCK_CATEGORIES.includes(category);
      if (!isStockCat && (!q || q.qty === 0)) continue;
      items.push({ sku, name: q?.name ?? sku, qty: q?.qty ?? 0, category });
    }
    items.sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty));
    return { at, items };
  } catch (e: any) {
    return { at, items: [], error: String(e?.message ?? e) };
  }
}

// ── 8. Sous seuil de sécurité (3 catégories stock) ───────────────────────────
// Les seuils EXISTENT déjà : lab_stock_safety_thresholds, saisis par les chefs dans l'onglet
// Analytique de leur station (2026-08-21). Zéro nouvelle saisie — un SKU sans seuil n'alerte pas.
export interface SafetyStockIssue { sku: string; name: string; category: string; qty: number; threshold: number }

export async function checkSafetyStock(supabase: SupabaseClient, snapshot: StockSnapshot): Promise<SafetyStockIssue[]> {
  if (snapshot.error) return [];
  const stockItems = snapshot.items.filter(i => i.category && STOCK_CATEGORIES.includes(i.category));
  if (!stockItems.length) return [];
  const { data: rows } = await supabase.from('lab_stock_safety_thresholds').select('sku, threshold');
  const thr: Record<string, number> = {};
  for (const r of rows ?? []) thr[r.sku] = Number(r.threshold);
  return stockItems
    .filter(i => thr[i.sku] != null && i.qty < thr[i.sku])
    .map(i => ({ sku: i.sku, name: i.name, category: i.category!, qty: i.qty, threshold: thr[i.sku] }))
    .sort((a, b) => (a.qty / a.threshold) - (b.qty / b.threshold));
}

// ── 9. Stock résiduel / négatif persistant — made-to-order ───────────────────
// Règle absolue (pas besoin d'inventaire) : un SKU made-to-order avec stock ≠ 0 doit être
// expliqué par un ENVOI en stock récent (<48h, seuil Axel 2026-09-02 — l'envoi est l'événement
// qui crée la MO Odoo ; la réception est interne à l'app et ignorée exprès) ou par une
// livraison à venir (aujourd'hui/demain). Sinon : positif = stock qui traîne (oubli, annulation
// jamais scrappée, vol…) ; négatif = livré mais jamais envoyé en stock (production Odoo
// manquante).
export interface OrphanStockIssue {
  sku: string; name: string; category: string | null; qty: number;
  sent48h: number; upcoming: number;
  kind: 'orphan_positive' | 'negative_stuck';
}

// Explications d'un stock MTO ≠ 0 : envois en stock <48h (création du transfert = l'événement
// qui crée la MO Odoo) + demande à livrer aujourd'hui/demain. Partagé entre checkOrphanStock et
// la section stock d'/analytics (qui recalcule ces 2 maps au rendu, sans appel Odoo).
export async function collectMtoExplanations(supabase: SupabaseClient, skus: string[]): Promise<{ sent: Record<string, number>; upcoming: Record<string, number> }> {
  const sent: Record<string, number> = {};
  const upcoming: Record<string, number> = {};
  if (!skus.length) return { sent, upcoming };
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const today = toDateStr(new Date());
  const tomorrow = toDateStr(new Date(Date.now() + 86400000));
  const { data: transfers } = await supabase.from('lab_stock_transfers').select('id').gte('created_at', since);
  const tids = (transfers ?? []).map((t: any) => t.id);
  if (tids.length) {
    const { data: tlines } = await supabase.from('lab_stock_transfer_lines')
      .select('sku, qty_sent').in('transfer_id', tids).in('sku', skus);
    for (const l of tlines ?? []) if (l.sku) sent[l.sku] = (sent[l.sku] ?? 0) + Number(l.qty_sent ?? 0);
  }
  const { data: demand } = await supabase.from('lab_order_lines')
    .select('product_sku, qty')
    .gte('delivery_date', today).lte('delivery_date', tomorrow)
    .gt('qty', 0).eq('published', true).in('product_sku', skus).limit(5000);
  for (const d of demand ?? []) if (d.product_sku) upcoming[d.product_sku] = (upcoming[d.product_sku] ?? 0) + Number(d.qty ?? 0);
  return { sent, upcoming };
}

export async function checkOrphanStock(supabase: SupabaseClient, snapshot: StockSnapshot): Promise<OrphanStockIssue[]> {
  if (snapshot.error) return [];
  const mto = snapshot.items.filter(i => i.qty !== 0 && !(i.category && STOCK_CATEGORIES.includes(i.category)));
  if (!mto.length) return [];
  const { sent, upcoming } = await collectMtoExplanations(supabase, mto.map(i => i.sku));
  const issues: OrphanStockIssue[] = [];
  for (const i of mto) {
    const s = sent[i.sku] ?? 0, u = upcoming[i.sku] ?? 0;
    if (i.qty > 0 && s === 0 && u === 0) issues.push({ ...i, sent48h: s, upcoming: u, kind: 'orphan_positive' });
    else if (i.qty < 0 && s === 0) issues.push({ ...i, sent48h: s, upcoming: u, kind: 'negative_stuck' });
  }
  return issues.sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty));
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export interface AllChecksResult {
  reconciliation: ReconciliationResult;
  checkRangeFrom: string;
  checkRangeTo: string;
  deliveryCoverage: DeliveryCoverageIssue[];
  productionStock: ProductionStockIssue[];
  stockOdoo: StockOdooIssue[];
  odooVolume: OdooVolume;
  lateDeliveries: LateDeliveryIssue[];
  stockSnapshot: StockSnapshot;
  safetyStock: SafetyStockIssue[];
  orphanStock: OrphanStockIssue[];
}

export async function runAllChecks(supabase: SupabaseClient): Promise<AllChecksResult> {
  const { from, to } = checkWindow();
  // The 2026-09-02 stock checks are individually guarded — a failure there degrades to an empty
  // result (plus snapshot.error), it can never take the whole run down with it.
  const stockPipeline = (async () => {
    const snapshot = await collectLabStockSnapshot(supabase);
    const [safetyStock, orphanStock] = await Promise.all([
      checkSafetyStock(supabase, snapshot).catch((): SafetyStockIssue[] => []),
      checkOrphanStock(supabase, snapshot).catch((): OrphanStockIssue[] => []),
    ]);
    return { snapshot, safetyStock, orphanStock };
  })();
  const [reconciliation, deliveryCoverage, productionStock, stockOdoo, odooVolume, lateDeliveries, stock] = await Promise.all([
    runReconciliationCheck(supabase),
    checkDeliveryCoverage(supabase, from, to),
    checkProductionToStock(supabase, from, to),
    checkStockToOdoo(supabase, from, to),
    measureOdooFetchVolume(),
    checkLateDeliveries(supabase).catch((): LateDeliveryIssue[] => []),
    stockPipeline,
  ]);
  return {
    reconciliation, checkRangeFrom: from, checkRangeTo: to, deliveryCoverage, productionStock, stockOdoo, odooVolume,
    lateDeliveries, stockSnapshot: stock.snapshot, safetyStock: stock.safetyStock, orphanStock: stock.orphanStock,
  };
}
