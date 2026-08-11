// Live Odoo price lookup for ONE sales order — used only by the /delivery-print page, only for
// source_type='sales_order', only when someone actually clicks through to print (not on every
// delivery-check page view — that anti-pattern was already fixed once for packaging, see
// odoo-packaging-sync.ts's header comment). A single order's price lookup is 2 small calls, paid
// once per print action, not multiplied across every order on a list page.
//
// Amount must be computed on DELIVERED quantity (qty_checked), not the quantity the customer
// originally ordered — Axel, 2026-08-11: "le montant se calcule sur la quantité livrée". Odoo's
// own price_subtotal is for the ordered qty, so this derives a per-unit price (price_subtotal /
// product_uom_qty, weighted across any duplicate-SKU lines on the same order) and multiplies by
// delivered qty at print time instead of trusting Odoo's line total directly.
import { odooExecute } from '@/lib/odoo';

export interface SoLinePricing {
  bySku: Record<string, { unitPrice: number }>;
  currency: string;
}

export async function fetchSoLinePricing(orderRef: string): Promise<SoLinePricing | null> {
  const orders = await odooExecute<any[]>('sale.order', 'search_read',
    [[['name', '=', orderRef]]], { fields: ['id', 'currency_id'], limit: 1 });
  const order = orders[0];
  if (!order) return null;

  const lines = await odooExecute<any[]>('sale.order.line', 'search_read',
    [[['order_id', '=', order.id], ['display_type', '=', false]]],
    { fields: ['product_id', 'product_uom_qty', 'price_subtotal'], limit: 500 });
  if (!lines.length) return { bySku: {}, currency: order.currency_id?.[1] ?? 'VND' };

  const productIds = Array.from(new Set(lines.map(l => l.product_id?.[0]).filter(Boolean))) as number[];
  const products = productIds.length
    ? await odooExecute<any[]>('product.product', 'read', [productIds], { fields: ['default_code'] })
    : [];
  const skuByProductId: Record<number, string> = {};
  for (const p of products) if (p.default_code) skuByProductId[p.id] = p.default_code;

  // Weighted average unit price per SKU — handles the rare case of two lines for the same SKU
  // (e.g. a discount applied to one) by summing amount and qty separately before dividing.
  const totalsBySku: Record<string, { amount: number; qty: number }> = {};
  for (const l of lines) {
    const sku = skuByProductId[l.product_id?.[0]];
    if (!sku) continue;
    const e = totalsBySku[sku] ??= { amount: 0, qty: 0 };
    e.amount += Number(l.price_subtotal ?? 0);
    e.qty += Number(l.product_uom_qty ?? 0);
  }
  const bySku: Record<string, { unitPrice: number }> = {};
  for (const [sku, t] of Object.entries(totalsBySku)) {
    if (t.qty > 0) bySku[sku] = { unitPrice: t.amount / t.qty };
  }
  return { bySku, currency: order.currency_id?.[1] ?? 'VND' };
}
