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
    const allOrders = Array.from(new Map((orderLines ?? []).map((l: any) =>
      [l.order_ref, { order_ref: l.order_ref, source_type: l.source_type, delivery_date: l.delivery_date, shop_name: l.shop_name }])).values());
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
    const excludedSet = new Set((excludedRows ?? []).map((r: any) => r.sku));
    if (!excludedSet.size) return { ...res, ok: true };

    const salesRefs = orders.filter(o => o.source_type === 'sales_order').map(o => o.order_ref);
    const replRefs = orders.filter(o => o.source_type === 'replenishment').map(o => o.order_ref);

    const rows: { order_ref: string; delivery_date: string; source_type: string; shop_name: string | null; sku: string; product_name_vi: string; qty: number; note: string | null }[] = [];

    if (salesRefs.length) {
      const soOrders = await tmo(odooExecute<any[]>('sale.order', 'search_read',
        [[['name', 'in', salesRefs]]], { fields: ['id', 'name'], limit: 500 }), 20000, 'so-orders');
      const idByRef: Record<number, string> = {};
      for (const o of soOrders) idByRef[o.id] = o.name;
      const ids = soOrders.map((o: any) => o.id);
      if (ids.length) {
        const lines = await tmo(odooExecute<any[]>('sale.order.line', 'search_read',
          [[['order_id', 'in', ids]]], { fields: ['order_id', 'product_id', 'product_uom_qty'], limit: 5000 }), 25000, 'so-lines');
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
          [[['request_id', 'in', ids]]], { fields: ['request_id', 'product_id', 'quantity_requested', 'note'], limit: 5000 }), 25000, 'repl-lines');
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
  const products = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['id', 'in', productIds]]], { fields: ['id', 'name', 'default_code', 'display_name'] }), 15000, 'products');
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
