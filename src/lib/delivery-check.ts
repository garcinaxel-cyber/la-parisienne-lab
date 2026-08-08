// Assistant delivery-check: materializes lab_delivery_orders + lab_delivery_check_lines for
// one (date, order_ref) on first open. Producible items come from lab_order_lines (already
// imported); packaging/matières lines are read LIVE from Odoo (odoo-sync.ts's excludedSet
// deliberately keeps them out of lab_order_lines — see lab_v33 migration note, and the
// 2026-08-08 diagnostic: reusing lab_order_lines for them would break the reconciliation
// feature, which expects every order-line row to eventually be produced).
import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export type SourceType = 'sales_order' | 'replenishment';

export interface CheckLine {
  id: string;
  sku: string | null;
  product_name_vi: string;
  product_name_en: string | null;
  category: 'production' | 'packaging';
  team: string | null;
  qty_expected: number;
  qty_checked: number | null;
  status: 'pending' | 'ok' | 'adjusted';
  discrepancy_reason: string | null;
  discrepancy_note: string | null;
  checked_by_name: string | null;
  checked_at: string | null;
}

export interface DeliveryOrderHeader {
  id: string;
  delivery_date: string;
  order_ref: string;
  source_type: SourceType;
  shop_name: string | null;
  customer_name: string | null;
  status: 'in_progress' | 'validated';
  validated_at: string | null;
  validated_by_name: string | null;
  odoo_push_status: string | null;
  odoo_push_error: string | null;
}

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

async function mapPackagingLines(rawLines: any[], qtyField: string, excludedSet: Set<string>) {
  const productIds = Array.from(new Set(rawLines.map(l => l.product_id?.[0]).filter(Boolean)));
  if (!productIds.length) return [];
  const products = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['id', 'in', productIds]]], { fields: ['id', 'name', 'default_code'] }), 15000, 'products');
  const bySku: Record<number, { sku: string; name: string }> = {};
  for (const p of products) bySku[p.id] = { sku: p.default_code || '', name: p.name || '' };
  const out: { sku: string; name: string; qty: number }[] = [];
  for (const l of rawLines) {
    const info = bySku[l.product_id?.[0]];
    if (!info?.sku || !excludedSet.has(info.sku)) continue;
    const qty = Math.round(Number(l[qtyField] ?? 0));
    if (!qty) continue;
    out.push({ sku: info.sku, name: String(info.name).replace(/\[.*?\]\s*/, ''), qty });
  }
  return out;
}

// Live Odoo read: packaging/matières lines for one order_ref — best-effort, never blocks
// the check screen from opening if Odoo is slow/unreachable (returns [] on error).
async function fetchPackagingLines(orderRef: string, sourceType: SourceType, excludedSet: Set<string>) {
  if (!odooConfigured() || !excludedSet.size) return [];
  try {
    if (sourceType === 'sales_order') {
      const orders = await tmo(odooExecute<any[]>('sale.order', 'search_read',
        [[['name', '=', orderRef]]], { fields: ['id'], limit: 1 }), 15000, 'so');
      if (!orders.length) return [];
      const soLines = await tmo(odooExecute<any[]>('sale.order.line', 'search_read',
        [[['order_id', '=', orders[0].id]]], { fields: ['product_id', 'product_uom_qty'], limit: 500 }), 15000, 'so-lines');
      return mapPackagingLines(soLines, 'product_uom_qty', excludedSet);
    } else {
      const reqs = await tmo(odooExecute<any[]>('stock.replenishment.request', 'search_read',
        [[['name', '=', orderRef]]], { fields: ['id'], limit: 1 }), 15000, 'repl');
      if (!reqs.length) return [];
      const repLines = await tmo(odooExecute<any[]>('stock.replenishment.request.line', 'search_read',
        [[['request_id', '=', reqs[0].id]]], { fields: ['product_id', 'quantity_requested'], limit: 500 }), 15000, 'repl-lines');
      return mapPackagingLines(repLines, 'quantity_requested', excludedSet);
    }
  } catch {
    return []; // best-effort — the produced-items check must still work if Odoo is unreachable
  }
}

export async function ensureDeliveryOrderChecklist(
  supabase: SupabaseClient, date: string, orderRef: string,
): Promise<{ header: DeliveryOrderHeader; lines: CheckLine[] }> {
  const { data: orderLines } = await supabase.from('lab_order_lines')
    .select('source_type, shop_name, product_sku, product_name_vi, product_name_en, team, qty')
    .eq('delivery_date', date).eq('order_ref', orderRef);

  const sourceType: SourceType =
    (orderLines?.[0]?.source_type as SourceType) ?? (orderRef.toUpperCase().startsWith('REP') ? 'replenishment' : 'sales_order');
  const shopName = orderLines?.[0]?.shop_name ?? null;

  const { data: existingHeader } = await supabase.from('lab_delivery_orders')
    .select('*').eq('delivery_date', date).eq('order_ref', orderRef).maybeSingle();
  let header = existingHeader as DeliveryOrderHeader | null;
  if (!header) {
    const { data: created, error } = await supabase.from('lab_delivery_orders')
      .insert({ delivery_date: date, order_ref: orderRef, source_type: sourceType, shop_name: shopName })
      .select('*').single();
    if (error) throw error;
    header = created as DeliveryOrderHeader;
  }

  const { data: excludedRows } = await supabase.from('lab_excluded_skus').select('sku');
  const excludedSet = new Set((excludedRows ?? []).map((r: any) => r.sku));
  const packaging = await fetchPackagingLines(orderRef, sourceType, excludedSet);

  const { data: existingLines } = await supabase.from('lab_delivery_check_lines')
    .select('sku, category').eq('delivery_order_id', header.id);
  const existingKeys = new Set((existingLines ?? []).map((l: any) => `${l.category}||${l.sku}`));

  // Aggregate producible lines by SKU — a client's bon can carry the same SKU across two
  // variant rows (e.g. size), and the check is per SKU, not per variant, for now.
  const bySku: Record<string, { name_vi: string; name_en: string | null; team: string | null; qty: number }> = {};
  for (const l of orderLines ?? []) {
    const k = l.product_sku;
    const e = bySku[k] ??= { name_vi: l.product_name_vi, name_en: l.product_name_en, team: l.team, qty: 0 };
    e.qty += l.qty;
  }

  const toInsert: any[] = [];
  for (const [sku, e] of Object.entries(bySku)) {
    const key = `production||${sku}`;
    if (existingKeys.has(key)) continue;
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku,
      product_name_vi: e.name_vi, product_name_en: e.name_en,
      category: 'production', team: e.team, qty_expected: e.qty,
    });
  }
  for (const p of packaging) {
    const key = `packaging||${p.sku}`;
    if (existingKeys.has(key)) continue;
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku: p.sku,
      product_name_vi: p.name, product_name_en: p.name,
      category: 'packaging', team: null, qty_expected: p.qty,
    });
  }
  if (toInsert.length) await supabase.from('lab_delivery_check_lines').insert(toInsert);

  const { data: lines } = await supabase.from('lab_delivery_check_lines')
    .select('*').eq('delivery_order_id', header.id).order('category', { ascending: true }).order('product_name_vi', { ascending: true });

  return { header, lines: (lines ?? []) as CheckLine[] };
}
