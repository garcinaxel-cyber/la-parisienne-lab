// Syncs packaging/matiere lines (odoo-sync.ts's excludedSet — boxes, ribbons, raw materials
// sold alongside production, never turned into a production card) into their own table,
// piggybacking on the SAME 15-min cron as the rest of the app instead of fetching them live
// from Odoo on every /delivery-check page view (that was the root cause of the slow
// delivery-check loads — 2-3 sequential Odoo round trips per order, on every single visit).
//
// COST NOTE (2026-08-08, Axel: minimize Vercel Fluid CPU / avoid piling more work onto a
// cron already flagged as a cost driver on 08-02): this only calls Odoo for order_refs that
// have NEVER been synced before (anti-join against lab_order_packaging_lines' own order_ref
// column via lab_order_sync_state below). Once an order's packaging has been fetched once,
// every later cron tick finds nothing new for it and does a single cheap Supabase query with
// zero Odoo calls. The Odoo cost is paid once per order, ever — not once per 15-min tick and
// not once per page view.
import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooConfigured } from '@/lib/odoo';
import { OemAwareExcludedSet } from '@/lib/oem';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export interface PackagingSyncResult {
  ok: boolean;
  orders_checked: number;
  lines_synced: number;
  error?: string;
}

// Rolling window matching the delivery-check feature's own scope (today + a few days ahead) —
// no point syncing packaging for orders far in the future or already delivered.
export async function syncOrderPackagingLines(supabase: SupabaseClient, dates: string[]): Promise<PackagingSyncResult> {
  const res: PackagingSyncResult = { ok: false, orders_checked: 0, lines_synced: 0 };
  if (!odooConfigured() || !dates.length) return res;

  try {
    const { data: importRows } = await supabase.from('lab_imports')
      .select('id').in('delivery_date', dates).eq('status', 'published');
    const importIds = (importRows ?? []).map((i: any) => i.id);
    if (!importIds.length) return { ...res, ok: true };

    const { data: orderLines } = await supabase.from('lab_order_lines')
      .select('order_ref, source_type, delivery_date, shop_name').in('import_id', importIds);
    const orderMap = new Map<string, { order_ref: string; source_type: string; delivery_date: string; shop_name: string | null }>((orderLines ?? []).map((l: any) =>
      [l.order_ref, { order_ref: l.order_ref, source_type: l.source_type, delivery_date: l.delivery_date, shop_name: l.shop_name }]));
    // 100%-packaging orders (no production line, so no lab_order_lines row) used to be invisible
    // here: written once by odoo-auto-sync.ts's packagingOnly path and never re-read, so neither a
    // line removed in Odoo nor an exact fractional qty ever reached them (2026-10-28 audit,
    // S04513 / REP/02053). Pick them up from their own packaging rows for the same dates.
    const { data: pkgOnlyRows } = await supabase.from('lab_order_packaging_lines')
      .select('order_ref, source_type, delivery_date, shop_name').in('delivery_date', dates);
    for (const r of (pkgOnlyRows ?? []) as any[]) {
      if (!orderMap.has(r.order_ref)) orderMap.set(r.order_ref, { order_ref: r.order_ref, source_type: r.source_type, delivery_date: r.delivery_date, shop_name: r.shop_name });
    }
    const allOrders = Array.from(orderMap.values());
    if (!allOrders.length) return { ...res, ok: true };

    // Cost control: only ever call Odoo again for an order_ref once its delivery date has
    // PASSED. lab_order_packaging_sync_state records every order checked (even ones with zero
    // packaging lines) so a steady-state cron tick with no new/upcoming orders costs one cheap
    // Supabase query and zero Odoo calls.
    //
    // BUG FIX 2026-08-16 (REP/2026/01049, Axel: "je n'ai pas les packaging de cette commande"):
    // this used to skip an order FOREVER after its first check, even a zero-result one. odoo-sync.ts
    // explicitly assumes (see its packagingOnly comment) that a mixed order's excluded lines "get
    // picked up next cron tick by odoo-packaging-sync.ts" — true only the FIRST tick. VTTH113/
    // VTTH085 were added to REP/2026/01049 in Odoo well AFTER this order's first (zero-result)
    // packaging check, so they were silently invisible forever: nothing else in the sync ever
    // re-examines packaging for an already-seen order (odoo-sync.ts's own diff explicitly ignores
    // excluded SKUs — see its excludedSet.has(sku) guards — precisely so this file stays the one
    // and only place responsible for them). Now only orders whose delivery date is in the past are
    // treated as permanently done; anything still upcoming is re-checked every tick until it is —
    // bounded cost since `dates` is already a short rolling window (today + a few days ahead).
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    const { data: alreadySynced } = await supabase.from('lab_order_packaging_sync_state')
      .select('order_ref').in('order_ref', allOrders.map(o => o.order_ref));
    const syncedSet = new Set((alreadySynced ?? []).map((r: any) => r.order_ref));
    const orders = allOrders.filter(o => !syncedSet.has(o.order_ref) || o.delivery_date >= today);
    res.orders_checked = orders.length;
    if (!orders.length) return { ...res, ok: true };

    const { data: excludedRows } = await supabase.from('lab_excluded_skus').select('sku');
    // OEM SKUs (MM-/OEM-) count as excluded too — see lib/oem.ts.
    const excludedSet = new OemAwareExcludedSet((excludedRows ?? []).map((r: any) => r.sku));

    const salesRefs = orders.filter(o => o.source_type === 'sales_order').map(o => o.order_ref);
    const replRefs = orders.filter(o => o.source_type === 'replenishment').map(o => o.order_ref);

    const rows: { order_ref: string; delivery_date: string; source_type: string; shop_name: string | null; sku: string; product_name_vi: string; qty: number; note: string | null }[] = [];
    // Refs whose Odoo lines were read in full this pass — the only ones where a packaging row
    // missing from Odoo can safely be treated as "removed in Odoo" (never on a partial read).
    const completeRefs = new Set<string>();
    const LINE_LIMIT = 5000;

    if (salesRefs.length) {
      const soOrders = await tmo(odooExecute<any[]>('sale.order', 'search_read',
        [[['name', 'in', salesRefs]]], { fields: ['id', 'name'], limit: 500 }), 20000, 'so-orders');
      const idByRef: Record<number, string> = {};
      for (const o of soOrders) idByRef[o.id] = o.name;
      const ids = soOrders.map((o: any) => o.id);
      if (ids.length) {
        const lines = await tmo(odooExecute<any[]>('sale.order.line', 'search_read',
          [[['order_id', 'in', ids]]], { fields: ['order_id', 'product_id', 'product_uom_qty'], limit: LINE_LIMIT }), 25000, 'so-lines');
        if (Array.isArray(lines) && lines.length < LINE_LIMIT) for (const o of soOrders) completeRefs.add(o.name);
        // sale.order.line has no native `note` field for packaging rows (unlike replenishment
        // lines) — a salesperson's note here would be a separate line_note row, not worth the
        // extra query for packaging-only items. Left null on purpose.
        rows.push(...(await mapExcludedLines(lines, 'product_uom_qty', 'order_id', idByRef, excludedSet, orders, 'sales_order')));
      }
    }
    if (replRefs.length) {
      const reqs = await tmo(odooExecute<any[]>('stock.replenishment.request', 'search_read',
        [[['name', 'in', replRefs]]], { fields: ['id', 'name'], limit: 500 }), 20000, 'repl-reqs');
      const idByRef: Record<number, string> = {};
      for (const r of reqs) idByRef[r.id] = r.name;
      const ids = reqs.map((r: any) => r.id);
      if (ids.length) {
        const lines = await tmo(odooExecute<any[]>('stock.replenishment.request.line', 'search_read',
          [[['request_id', 'in', ids]]], { fields: ['request_id', 'product_id', 'quantity_requested', 'note'], limit: LINE_LIMIT }), 25000, 'repl-lines');
        if (Array.isArray(lines) && lines.length < LINE_LIMIT) for (const r of reqs) completeRefs.add(r.name);
        rows.push(...(await mapExcludedLines(lines, 'quantity_requested', 'request_id', idByRef, excludedSet, orders, 'replenishment')));
      }
    }

    // BUG FIX 2026-08-17 (REP/2026/01076, same root cause as odoo-auto-sync.ts's packagingOnly
    // write — see that file's doc comment for the reproduced Postgres error): Odoo lets the same
    // excluded SKU appear on multiple lines of one order (e.g. one sticker line per cake flavor),
    // so `rows` can carry duplicate (order_ref, sku) pairs. Upserting duplicates in one batch is
    // rejected outright by Postgres (21000 "ON CONFLICT DO UPDATE command cannot affect row a
    // second time") — worse here than in odoo-auto-sync.ts, since this upsert spans EVERY order in
    // the current batch, so one order with a repeated SKU would fail packaging sync for every
    // other order alongside it too. Aggregate (sum qty, merge notes) before upserting.
    const rowsAgg = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const k = `${r.order_ref}||${r.sku}`;
      const cur = rowsAgg.get(k);
      if (!cur) rowsAgg.set(k, { ...r });
      else {
        cur.qty += r.qty;
        if (r.note && !cur.note?.includes(r.note)) cur.note = cur.note ? `${cur.note} / ${r.note}` : r.note;
      }
    }
    if (rowsAgg.size) {
      const { error } = await supabase.from('lab_order_packaging_lines')
        .upsert(Array.from(rowsAgg.values()).map(r => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: 'order_ref,sku' });
      if (error) return { ...res, error: error.message };
    }
    // Lines removed in Odoo (or set to 0) — BUG FIX 2026-10-28 (REP/2026/02238, Axel: the
    // manager removed a strawberry purée from his draft, the app kept showing it). This sync used
    // to only ever upsert, so a removed packaging line stayed forever, in this table AND as a
    // frozen copy in the delivery checklist (14 phantom lines since August: 7 zeroed by hand,
    // 6 ticked OK and validated with no Odoo move). See removeStalePackagingLines.
    try { await removeStalePackagingLines(supabase, orders.map(o => o.order_ref), completeRefs, rowsAgg); }
    catch (e) { console.error('[packaging-sync] stale-line cleanup failed', e); }

    // Mark every order this pass actually checked as synced — including ones with zero
    // packaging lines — so they're never re-queried against Odoo again.
    await supabase.from('lab_order_packaging_sync_state')
      .upsert(orders.map(o => ({ order_ref: o.order_ref, synced_at: new Date().toISOString() })), { onConflict: 'order_ref' });
    res.lines_synced = rowsAgg.size;
    return { ...res, ok: true };
  } catch (e: any) {
    return { ...res, error: String(e?.message ?? e) };
  }
}

async function mapExcludedLines(
  lines: any[], qtyField: string, linkField: string, idByRef: Record<number, string>,
  excludedSet: Set<string>, orders: { order_ref: string; delivery_date: string; shop_name: string | null }[], sourceType: string,
) {
  const productIds = Array.from(new Set(lines.map(l => l.product_id?.[0]).filter(Boolean)));
  if (!productIds.length) return [];
  // context lang: vi_VN (Axel, 2026-09-03) — packaging/matière products carry an explicit
  // Odoo translation (English base name + separate Vietnamese one, confirmed live via a
  // product's Translate: name dialog), unlike production SKUs which are typed directly in
  // Vietnamese. Without this the app showed the English base name for every packaging line.
  const products = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['id', 'in', productIds]]], { fields: ['id', 'name', 'default_code', 'display_name'], context: { lang: 'vi_VN' } }), 15000, 'products');
  const bySku: Record<number, { sku: string; name: string }> = {};
  // Same fix as odoo-sync.ts (2026-08-27): plain `name` is the shared template name (no flavor
  // for variant products) — `display_name` is the only field carrying the variant's own
  // attribute value, e.g. "[SKU] Bánh La Plume D14 (Chocolate)".
  for (const p of products) {
    const variantName = String(p.display_name || '').replace(/\[.*?\]\s*/, '').trim();
    bySku[p.id] = { sku: p.default_code || '', name: variantName || p.name || '' };
  }
  const orderByRef: Record<string, { delivery_date: string; shop_name: string | null }> = {};
  for (const o of orders) orderByRef[o.order_ref] = { delivery_date: o.delivery_date, shop_name: o.shop_name };

  const out: { order_ref: string; delivery_date: string; source_type: string; shop_name: string | null; sku: string; product_name_vi: string; qty: number; note: string | null }[] = [];
  for (const l of lines) {
    const ref = idByRef[l[linkField]?.[0]];
    const info = bySku[l.product_id?.[0]];
    if (!ref || !info?.sku || !excludedSet.has(info.sku)) continue;
    // NOT Math.round — a raw material requested by weight/fraction (e.g. Mascarpone 500g
    // requested as 0.2, REP/2026/01043) used to round straight to 0 and get silently dropped by
    // the guard below (2026-08-14). Packaging/matiere qty is stored as numeric (lab_v41)
    // specifically so a fractional request survives intact.
    const qty = Number(l[qtyField] ?? 0);
    if (!qty) continue;
    const meta = orderByRef[ref];
    if (!meta) continue;
    out.push({
      order_ref: ref, delivery_date: meta.delivery_date, source_type: sourceType, shop_name: meta.shop_name,
      sku: info.sku, product_name_vi: String(info.name).replace(/\[.*?\]\s*/, ''), qty,
      note: (typeof l.note === 'string' && l.note.trim()) ? l.note.trim() : null,
    });
  }
  return out;
}

// Removes packaging rows that Odoo no longer has, for orders whose Odoo lines were read in full
// this pass. Safety rules:
//  - only refs in completeRefs (Odoo answered, read under the line limit) — a timeout or a
//    partial read never empties an order;
//  - an order already validated in the delivery check is left untouched (history);
//  - in the checklist, a packaging line nobody has counted yet is deleted; one already counted
//    keeps its count and gets qty_expected = 0, so the gap shows instead of erasing the work;
//  - a SKU still demanded through lab_order_lines (an excluded SKU on a production line, merged
//    into the same packaging bucket by delivery-check.ts) is never touched in the checklist.
async function removeStalePackagingLines(
  supabase: SupabaseClient, refs: string[], completeRefs: Set<string>,
  current: Map<string, { order_ref: string; sku: string }>,
) {
  const checkRefs = refs.filter(r => completeRefs.has(r));
  if (!checkRefs.length) return;
  const { data: existing } = await supabase.from('lab_order_packaging_lines')
    .select('id, order_ref, sku').in('order_ref', checkRefs);
  const stale = ((existing ?? []) as any[]).filter(r => !current.has(`${r.order_ref}||${r.sku}`));
  if (!stale.length) return;

  const staleRefs = Array.from(new Set(stale.map(r => r.order_ref)));
  const { data: headers } = await supabase.from('lab_delivery_orders')
    .select('id, order_ref, validated_at').in('order_ref', staleRefs);
  const validatedRefs = new Set(((headers ?? []) as any[]).filter(h => h.validated_at).map(h => h.order_ref));
  const toRemove = stale.filter(r => !validatedRefs.has(r.order_ref));
  if (!toRemove.length) return;

  const { error: delErr } = await supabase.from('lab_order_packaging_lines')
    .delete().in('id', toRemove.map(r => r.id));
  if (delErr) throw delErr;

  const { data: prodDemand } = await supabase.from('lab_order_lines')
    .select('order_ref, product_sku, qty').in('order_ref', staleRefs).gt('qty', 0);
  const demanded = new Set(((prodDemand ?? []) as any[]).map(l => `${l.order_ref}||${l.product_sku}`));
  const headerIdsByRef = new Map<string, string[]>();
  for (const h of (headers ?? []) as any[]) {
    if (h.validated_at) continue;
    headerIdsByRef.set(h.order_ref, [...(headerIdsByRef.get(h.order_ref) ?? []), h.id]);
  }
  for (const r of toRemove) {
    if (demanded.has(`${r.order_ref}||${r.sku}`)) continue;
    const ids = headerIdsByRef.get(r.order_ref);
    if (!ids?.length) continue;
    const { data: checkLines } = await supabase.from('lab_delivery_check_lines')
      .select('id, qty_checked').in('delivery_order_id', ids).eq('category', 'packaging').eq('sku', r.sku);
    for (const cl of (checkLines ?? []) as any[]) {
      if (cl.qty_checked === null || cl.qty_checked === undefined) {
        await supabase.from('lab_delivery_check_lines').delete().eq('id', cl.id);
      } else {
        await supabase.from('lab_delivery_check_lines').update({ qty_expected: 0 }).eq('id', cl.id);
      }
    }
  }
}
