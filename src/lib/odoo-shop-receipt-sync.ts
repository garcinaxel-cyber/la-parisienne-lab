// Prefill Odoo's OWN "reception quantity" on a REP order once a shop finishes confirming every
// line of its receipt check. Axel, 2026-08-27: "peux tu faire en sorte qu'à la fin la validation
// préremplisse la reception quantity dans les REP order ? pour les SO on a pas ça donc l'interface
// Moon ne peut pas avoir cette possibilité."
//
// Confirmed live via fields_get (odoo-scrap-debug route): stock.replenishment.request.line has
// its OWN plain, writable float field `quantity_received` ("Quantity that has been received at
// destination warehouse") — a completely separate mechanism from the stock.move/picking flow
// odoo-delivery-validate.ts already drives for the assistant's "Valider la livraison" button.
// sale.order has no equivalent field, which is exactly why this can never apply to Moon Flower
// (source_type='sales_order') — REP only, gated by the caller checking header.source_type first.
//
// Scope, per Axel (confirmed 2026-08-27): PREFILL ONLY. Never approves/submits the REP order,
// never touches stock.move or the picking, never validates anything — just writes the number so
// it's already there when a human later opens the order in Odoo. Best-effort: any failure here is
// swallowed (logged only) and never surfaces as an error to the shop's own UI — this is a
// convenience layer on top of the shop's confirmation, not a blocking step in it.
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from './odoo';

export interface ShopReceivedLine { sku: string; qtyReceived: number }

export async function prefillReplenishmentReceivedQty(
  orderRef: string,
  lines: ShopReceivedLine[],
): Promise<{ ok: boolean; error?: string; written?: number; skippedAmbiguous?: string[] }> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  if (!lines.length) return { ok: true, written: 0 };

  const reqs = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
    [[['name', '=', orderRef]]], { fields: ['id'] });
  const req = reqs[0];
  if (!req) return { ok: false, error: `Commande ${orderRef} introuvable dans Odoo` };

  const reqLines = await odooExecute<any[]>('stock.replenishment.request.line', 'search_read',
    [[['request_id', '=', req.id]]], { fields: ['id', 'product_id', 'quantity_requested'] });
  const productIds = Array.from(new Set(reqLines.map(l => l.product_id?.[0]).filter(Boolean))) as number[];
  const products = productIds.length
    ? await odooExecute<any[]>('product.product', 'read', [productIds], { fields: ['default_code'] })
    : [];
  const skuByProductId: Record<number, string> = {};
  for (const p of products) skuByProductId[p.id] = p.default_code || '';

  const linesBySku: Record<string, { id: number; requested: number }[]> = {};
  for (const l of reqLines) {
    const sku = skuByProductId[l.product_id?.[0]];
    if (!sku) continue;
    (linesBySku[sku] ??= []).push({ id: l.id, requested: Number(l.quantity_requested ?? 0) });
  }

  let written = 0;
  const skippedAmbiguous: string[] = [];
  for (const { sku, qtyReceived } of lines) {
    const odooLines = linesBySku[sku];
    if (!odooLines?.length) continue; // e.g. a packaging-only check line — no matching REP line to prefill

    if (odooLines.length === 1) {
      await odooExecuteWrite('stock.replenishment.request.line', 'write', [[odooLines[0].id], { quantity_received: qtyReceived }]);
      written++;
      continue;
    }
    // Same rare ambiguity odoo-delivery-validate.ts calls needsSplit for (one SKU, >1 Odoo
    // lines) — but this is a best-effort prefill, not a blocking validation step, so an
    // unresolvable split is just skipped rather than guessed at.
    const requestedSum = odooLines.reduce((s, o) => s + o.requested, 0);
    if (qtyReceived === requestedSum) {
      for (const o of odooLines) await odooExecuteWrite('stock.replenishment.request.line', 'write', [[o.id], { quantity_received: o.requested }]);
      written += odooLines.length;
    } else {
      skippedAmbiguous.push(sku);
    }
  }
  return { ok: true, written, skippedAmbiguous: skippedAmbiguous.length ? skippedAmbiguous : undefined };
}
