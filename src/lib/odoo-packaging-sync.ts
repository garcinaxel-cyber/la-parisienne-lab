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

    // Cost control: only ever call Odoo for an order_ref once. lab_order_packaging_sync_state
    // records every order checked (even ones with zero packaging lines) so a steady-state
    // cron tick with no new orders costs one cheap Supabase query and zero Odoo calls.
    const { data: alreadySynced } = await supabase.from('lab_order_packaging_sync_state')
      .select('order_ref').in('order_ref', allOrders.map(o => o.order_ref));
    const syncedSet = new Set((alreadySynced ?? []).map((r: any) => r.order_ref));
    const orders = allOrders.filter(o => !syncedSet.has(o.order_ref));
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

    if (rows.length) {
      const { error } = await supabase.from('lab_order_packaging_lines')
        .upsert(rows.map(r => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: 'order_ref,sku' });
      if (error) return { ...res, error: error.message };
    }
    // Mark every order this pass actually checked as synced — including ones with zero
    // packaging lines — so they're never re-queried against Odoo again.
    await supabase.from('lab_order_packaging_sync_state')
      .upsert(orders.map(o => ({ order_ref: o.order_ref, synced_at: new Date().toISOString() })), { onConflict: 'order_ref' });
    res.lines_synced = rows.length;
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
    [[['id', 'in', productIds]]], { fields: ['id', 'name', 'default_code'] }), 15000, 'products');
  const bySku: Record<number, { sku: string; name: string }> = {};
  for (const p of products) bySku[p.id] = { sku: p.default_code || '', name: p.name || '' };
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
