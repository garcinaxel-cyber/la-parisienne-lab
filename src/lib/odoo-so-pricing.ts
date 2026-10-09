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
//
// VAT (2026-08-12, Axel: wants Untaxed/Tax/Total like Odoo's own SO printout, but warned "ils
// n'ont pas tous la même taxation" — checked live: confirmed true, and worse than per-ORDER:
// S03135 has a tax-exempt line (Red Naomi, tax_id=[]) mixed with 8%-taxed lines on the SAME
// order, so even a per-order rate would be wrong for that line. Tax must be derived PER SKU from
// Odoo's own price_tax/price_subtotal ratio on each line, exactly like unitPrice is — never a
// hardcoded/global rate. sale.order.amount_tax (order-level) is deliberately NOT used: it's
// computed on the customer's ORDERED qty, not the DELIVERED qty this printout bases everything
// on, so it would silently mismatch the line total whenever delivered != ordered.
import { odooExecute } from '@/lib/odoo';

export interface SoLinePricing {
  // unitPrice: untaxed, AFTER the line's discount (what the customer pays, as before).
  // listUnitPrice / discountPct (2026-10-09, S04171 HAPPY TRUE MARKET -35%: the shop asked for
  // the customer to see the discounted price too): untaxed price BEFORE the discount and the
  // discount itself, so the printout can show both. discountPct 0 = no discount on that SKU.
  bySku: Record<string, { unitPrice: number; taxRate: number; listUnitPrice: number; discountPct: number }>;
  currency: string;
}

export async function fetchSoLinePricing(orderRef: string): Promise<SoLinePricing | null> {
  const orders = await odooExecute<any[]>('sale.order', 'search_read',
    [[['name', '=', orderRef]]], { fields: ['id', 'currency_id'], limit: 1 });
  const order = orders[0];
  if (!order) return null;

  const lines = await odooExecute<any[]>('sale.order.line', 'search_read',
    [[['order_id', '=', order.id], ['display_type', '=', false]]],
    { fields: ['product_id', 'product_uom_qty', 'price_subtotal', 'price_tax', 'price_unit', 'discount'], limit: 500 });
  if (!lines.length) return { bySku: {}, currency: order.currency_id?.[1] ?? 'VND' };

  const productIds = Array.from(new Set(lines.map(l => l.product_id?.[0]).filter(Boolean))) as number[];
  const products = productIds.length
    ? await odooExecute<any[]>('product.product', 'read', [productIds], { fields: ['default_code'] })
    : [];
  const skuByProductId: Record<number, string> = {};
  for (const p of products) if (p.default_code) skuByProductId[p.id] = p.default_code;

  // Weighted average unit price AND tax rate per SKU — handles the rare case of two lines for
  // the same SKU (e.g. a free-replacement line at price_subtotal=0 alongside a paid one, both
  // seen live on S03135/BMGM) by summing amount/tax/qty separately before dividing.
  const totalsBySku: Record<string, { amount: number; listAmount: number; tax: number; qty: number }> = {};
  for (const l of lines) {
    const sku = skuByProductId[l.product_id?.[0]];
    if (!sku) continue;
    const e = totalsBySku[sku] ??= { amount: 0, listAmount: 0, tax: 0, qty: 0 };
    const amount = Number(l.price_subtotal ?? 0);
    const disc = Math.max(0, Math.min(100, Number(l.discount ?? 0)));
    e.amount += amount;
    // Untaxed amount before the discount, rebuilt from Odoo's own untaxed line total. A line at
    // 100% has no untaxed total left to rebuild from — it then counts as not discounted (its
    // amount stays 0, exactly as before), so the printout never invents a list price.
    e.listAmount += disc > 0 && disc < 100 ? amount / (1 - disc / 100) : amount;
    e.tax += Number(l.price_tax ?? 0);
    e.qty += Number(l.product_uom_qty ?? 0);
  }
  const bySku: SoLinePricing['bySku'] = {};
  for (const [sku, t] of Object.entries(totalsBySku)) {
    if (t.qty <= 0) continue;
    const discountPct = t.listAmount > 0 ? Math.round((1 - t.amount / t.listAmount) * 10000) / 100 : 0;
    bySku[sku] = {
      unitPrice: t.amount / t.qty, taxRate: t.amount > 0 ? t.tax / t.amount : 0,
      listUnitPrice: t.listAmount / t.qty, discountPct: discountPct > 0.004 ? discountPct : 0,
    };
  }
  return { bySku, currency: order.currency_id?.[1] ?? 'VND' };
}
