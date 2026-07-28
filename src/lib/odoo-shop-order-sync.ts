import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured, labLocalToOdooUtc } from '@/lib/odoo';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// Shop -> Odoo document mapping. Quotation (sale.order) for Moon Flower / Lab / (future) B2B;
// Replenishment (stock.replenishment.request) for the 4 La Paris shops (their own warehouse).
// B2B is intentionally absent for now — the urgent-order form only offers these 6 shops until
// Axel gives the B2B list (see memory odoo-shop-order-sync-plan).
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
async function resolvePartnerId(name: string): Promise<number | null> {
  if (partnerIdCache.has(name)) return partnerIdCache.get(name)!;
  const rows = await tmo(odooExecute<any[]>('res.partner', 'search_read',
    [[['name', '=', name]]], { fields: ['id'], limit: 1 }), 15000, 'partner');
  const id = rows[0]?.id ?? null;
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

// Create ONE draft Odoo document (quotation or replenishment) covering every line of one
// order_batch_id (= one shop submission via /order/[token]). NEVER confirms it — stays in
// draft/quotation state for a human to validate in Odoo whenever. Mirrors odoo-mo-sync's
// tmo()-wrapped write pattern. The production card was already created (existing flow,
// unchanged) before this runs, so the chef's visibility never depends on this succeeding.
export async function createOdooOrderForBatch(
  supabase: SupabaseClient,
  batch: { orderBatchId: string; shopName: string; docType: 'quotation' | 'replenishment'; deliveryDate: string; readyTime: string | null },
): Promise<CreateOrderResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };

  const { data: rows } = await supabase.from('lab_manual_cakes')
    .select('product_sku, product_name_vi, qty')
    .eq('order_batch_id', batch.orderBatchId);
  const lines = (rows ?? []).filter(r => r.product_sku && (r.qty ?? 0) > 0);
  if (!lines.length) return { ok: false, error: 'No line found for this order' };

  const skus = Array.from(new Set(lines.map(l => l.product_sku as string)));
  let products: Record<string, { id: number; uom_id: number }>;
  try {
    products = await resolveProducts(skus);
  } catch (e: any) {
    return { ok: false, error: `Odoo product lookup failed: ${String(e?.message ?? e)}` };
  }
  const missing = skus.filter(s => !products[s]);
  if (missing.length) return { ok: false, error: `Product(s) not found in Odoo: ${missing.join(', ')}` };

  const map = SHOP_ODOO_MAP[batch.shopName];
  if (!map) return { ok: false, error: `No Odoo mapping for shop "${batch.shopName}"` };

  try {
    if (batch.docType === 'quotation') {
      if (!map.partnerName) return { ok: false, error: `No Odoo partner mapped for "${batch.shopName}"` };
      const partnerId = await resolvePartnerId(map.partnerName);
      if (!partnerId) return { ok: false, error: `Odoo partner "${map.partnerName}" not found` };

      const orderId = await tmo(odooExecuteWrite<number>('sale.order', 'create', [{
        partner_id: partnerId,
        commitment_date: labLocalToOdooUtc(batch.deliveryDate, batch.readyTime),
      }]), 25000, 'create sale.order');

      for (const l of lines) {
        const p = products[l.product_sku as string];
        await tmo(odooExecuteWrite('sale.order.line', 'create', [{
          order_id: orderId, product_id: p.id, product_uom_qty: l.qty,
          product_uom_id: p.uom_id, name: l.product_name_vi,
        }]), 20000, 'create sale.order.line');
      }

      const [order] = await tmo(odooExecuteWrite<any[]>('sale.order', 'read', [[orderId]], { fields: ['name'] }), 15000, 'read sale.order');
      return { ok: true, order_ref: order?.name };
    } else {
      if (!map.warehouseCode) return { ok: false, error: `No Odoo warehouse mapped for "${batch.shopName}"` };
      const wh = await resolveWarehouseId(map.warehouseCode);
      if (!wh) return { ok: false, error: `Odoo warehouse "${map.warehouseCode}" not found` };

      const reqId = await tmo(odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
        warehouse_id: wh.id,
        delivery_date: labLocalToOdooUtc(batch.deliveryDate, batch.readyTime),
      }]), 25000, 'create replenishment');

      for (const l of lines) {
        const p = products[l.product_sku as string];
        await tmo(odooExecuteWrite('stock.replenishment.request.line', 'create', [{
          request_id: reqId, product_id: p.id, quantity_requested: l.qty,
        }]), 20000, 'create replenishment line');
      }

      const [req] = await tmo(odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name'] }), 15000, 'read replenishment');
      return { ok: true, order_ref: req?.name };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
