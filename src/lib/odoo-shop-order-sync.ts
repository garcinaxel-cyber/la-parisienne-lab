import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured, labLocalToOdooUtc } from '@/lib/odoo';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// Shop -> Odoo document mapping. Quotation (sale.order) for Moon Flower / Lab / (future) B2B;
// Replenishment (stock.replenishment.request) for the 4 La Paris shops (their own warehouse).
// B2B is intentionally absent for now — the urgent-order form only offers these 6 shops until
// Axel gives the B2B list.
export const SHOP_ODOO_MAP: Record<string, { docType: 'quotation' | 'replenishment'; partnerName?: string; warehouseCode?: string }> = {
  'Moon Flower': { docType: 'quotation', partnerName: 'MOON FLOWER' },
  'Lab': { docType: 'quotation', partnerName: 'LAB' },
  'La Paris Tây Hồ': { docType: 'replenishment', warehouseCode: 'LP' },
  'La Paris Long Biên': { docType: 'replenishment', warehouseCode: 'PARIS' },
  'La Paris Bà Triệu': { docType: 'replenishment', warehouseCode: 'LPBT' },
  'La Paris Timecity': { docType: 'replenishment', warehouseCode: 'LPTC' },
};

export interface CreateOrderResult {
  ok: boolean;
  order_ref?: string;
  error?: string;
}

const partnerIdCache = new Map<string, number | null>();
// Exact '=' search came back empty even for a partner visibly named "LAB" in the UI
// (verified 07-28, id 347) — safer to match case/whitespace-insensitively via ilike then
// filter in JS, rather than trust Odoo's exact-match semantics on this field.
async function resolvePartnerId(name: string): Promise<number | null> {
  if (partnerIdCache.has(name)) return partnerIdCache.get(name)!;
  const rows = await tmo(odooExecute<any[]>('res.partner', 'search_read',
    [[['name', 'ilike', name]]], { fields: ['id', 'name'], limit: 20 }), 15000, 'partner');
  const target = name.trim().toLowerCase();
  const match = rows.find((r: any) => String(r.name ?? '').trim().toLowerCase() === target);
  const id = match?.id ?? null;
  partnerIdCache.set(name, id);
  return id;
}

const warehouseCache = new Map<string, { id: number; name: string } | null>();
async function resolveWarehouseId(code: string): Promise<{ id: number; name: string } | null> {
  if (warehouseCache.has(code)) return warehouseCache.get(code)!;
  const rows = await tmo(odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=', code]]], { fields: ['id', 'name'], limit: 1 }), 15000, 'warehouse');
  const w = rows[0] ? { id: rows[0].id, name: rows[0].name } : null;
  warehouseCache.set(code, w);
  return w;
}

async function resolveProducts(skus: string[]): Promise<Record<string, { id: number; uom_id: number }>> {
  if (!skus.length) return {};
  const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id'], limit: 2000 }), 20000, 'products');
  const out: Record<string, { id: number; uom_id: number }> = {};
  for (const p of rows) if (p.default_code) out[p.default_code] = { id: p.id, uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id };
  return out;
}

// The UoM field on sale.order.line is 'product_uom_id' on some Odoo versions and
// 'product_uom' on others (confirmed the hard way — 07-28 test run against this instance
// failed on 'product_uom_id' not existing). Discovered once, cached for the process lifetime.
let soLineUomField: string | null | undefined; // undefined = not yet resolved
async function resolveSoLineUomField(): Promise<string | null> {
  if (soLineUomField !== undefined) return soLineUomField;
  const fields = await tmo(odooExecute<any>('sale.order.line', 'fields_get', [[]], { attributes: ['type'] }), 15000, 'sol fields');
  soLineUomField = ['product_uom_id', 'product_uom'].find(f => fields[f]) ?? null;
  return soLineUomField;
}

// Create ONE draft Odoo document (quotation or replenishment) covering an admin-picked set of
// lab_manual_cakes rows. NEVER confirms it — stays in draft state for a human to validate in
// Odoo whenever. This is a deliberately SEMI-automatic, synchronous action (no queue, no cron):
// an admin selects one or more exceptional orders on /exceptional-orders — all from the same
// shop, since one Odoo document maps to one partner/warehouse — and clicks "Create Odoo order".
// Grouping several same-day orders for one client (e.g. 5 Moon Flower birthday cakes in one
// day) into a single quotation is exactly the point; the previous fully-automatic queue+cron
// version created duplicate documents on retries and was scrapped (see git history).
export async function createOdooOrderForSelection(
  supabase: SupabaseClient,
  manualCakeIds: string[],
): Promise<CreateOrderResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  if (!manualCakeIds.length) return { ok: false, error: 'No order selected' };

  const { data: rows } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, product_name_vi, qty, shop_name, delivery_date, ready_time, matched_order_ref')
    .in('id', manualCakeIds);

  const already = (rows ?? []).find(r => r.matched_order_ref);
  if (already) return { ok: false, error: `An order in this selection is already linked to ${already.matched_order_ref}` };

  const lines = (rows ?? []).filter(r => r.product_sku && (r.qty ?? 0) > 0);
  if (!lines.length) return { ok: false, error: 'No valid line in this selection' };

  const shopNames = Array.from(new Set(lines.map(l => l.shop_name).filter(Boolean)));
  if (shopNames.length === 0) return { ok: false, error: 'Selected order(s) have no shop attached' };
  if (shopNames.length > 1) return { ok: false, error: `Selection mixes several shops: ${shopNames.join(', ')}` };
  const shopName = shopNames[0] as string;

  const map = SHOP_ODOO_MAP[shopName];
  if (!map) return { ok: false, error: `No Odoo mapping for shop "${shopName}"` };

  // Grouping is meant for same-day orders; if dates differ, use the earliest as the
  // document's commitment/delivery date rather than blocking the admin's choice.
  const deliveryDate = lines.map(l => l.delivery_date as string).sort()[0];
  const readyTime = lines.find(l => l.ready_time)?.ready_time as string | null | undefined ?? null;

  const skus = Array.from(new Set(lines.map(l => l.product_sku as string)));
  let products: Record<string, { id: number; uom_id: number }>;
  try {
    products = await resolveProducts(skus);
  } catch (e: any) {
    return { ok: false, error: `Odoo product lookup failed: ${String(e?.message ?? e)}` };
  }
  const missing = skus.filter(s => !products[s]);
  if (missing.length) return { ok: false, error: `Product(s) not found in Odoo: ${missing.join(', ')}` };

  try {
    let orderRef: string | undefined;

    if (map.docType === 'quotation') {
      if (!map.partnerName) return { ok: false, error: `No Odoo partner mapped for "${shopName}"` };
      const partnerId = await resolvePartnerId(map.partnerName);
      if (!partnerId) return { ok: false, error: `Odoo partner "${map.partnerName}" not found` };

      const uomField = await resolveSoLineUomField();
      const orderId = await tmo(odooExecuteWrite<number>('sale.order', 'create', [{
        partner_id: partnerId,
        commitment_date: labLocalToOdooUtc(deliveryDate, readyTime),
      }]), 25000, 'create sale.order');

      try {
        for (const l of lines) {
          const p = products[l.product_sku as string];
          await tmo(odooExecuteWrite('sale.order.line', 'create', [{
            order_id: orderId, product_id: p.id, product_uom_qty: l.qty,
            ...(uomField ? { [uomField]: p.uom_id } : {}),
            name: l.product_name_vi,
          }]), 20000, 'create sale.order.line');
        }
      } catch (lineErr: any) {
        try { await odooExecuteWrite('sale.order', 'unlink', [[orderId]]); } catch { /* best-effort */ }
        throw lineErr;
      }

      const [order] = await tmo(odooExecuteWrite<any[]>('sale.order', 'read', [[orderId]], { fields: ['name'] }), 15000, 'read sale.order');
      orderRef = order?.name;
    } else {
      if (!map.warehouseCode) return { ok: false, error: `No Odoo warehouse mapped for "${shopName}"` };
      const wh = await resolveWarehouseId(map.warehouseCode);
      if (!wh) return { ok: false, error: `Odoo warehouse "${map.warehouseCode}" not found` };
      // Every replenishment ships FROM the lab's own warehouse.
      const sourceWh = await resolveWarehouseId('LAB');
      if (!sourceWh) return { ok: false, error: `Odoo source warehouse "LAB" not found` };

      const reqId = await tmo(odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
        warehouse_id: wh.id, source_warehouse_id: sourceWh.id,
        delivery_date: labLocalToOdooUtc(deliveryDate, readyTime),
      }]), 25000, 'create replenishment');

      try {
        for (const l of lines) {
          const p = products[l.product_sku as string];
          await tmo(odooExecuteWrite('stock.replenishment.request.line', 'create', [{
            request_id: reqId, product_id: p.id, quantity_requested: l.qty,
          }]), 20000, 'create replenishment line');
        }
      } catch (lineErr: any) {
        try { await odooExecuteWrite('stock.replenishment.request', 'unlink', [[reqId]]); } catch { /* best-effort */ }
        throw lineErr;
      }

      const [req] = await tmo(odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name'] }), 15000, 'read replenishment');
      orderRef = req?.name;
    }

    if (!orderRef) return { ok: false, error: 'Odoo document created but could not read its reference' };

    // Link every selected manual-cake row to the newly created document so the UI reflects
    // it immediately (same field the existing auto-match mechanism uses).
    const { error: linkErr } = await supabase.from('lab_manual_cakes')
      .update({ matched_order_ref: orderRef })
      .in('id', lines.map(l => l.id as string));
    if (linkErr) return { ok: true, order_ref: orderRef, error: `Order ${orderRef} created but failed to link locally: ${linkErr.message}` };

    return { ok: true, order_ref: orderRef };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
