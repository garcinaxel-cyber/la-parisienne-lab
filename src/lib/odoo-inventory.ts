// Server-only: finished-goods inventory count → Odoo stock.quant.
// Read-only account resolves the LAB/Stock location + product ids + current on-hand.
// Write account (same as delivery validation, odoo-delivery-validate.ts) applies the count.
// Nothing is written to Odoo until the caller passes dryRun=false — the UI always previews
// first (see lab_v43_finished_goods_inventory.sql).
//
// Odoo's inventory-count mechanism (modern stock.quant, no more stock.inventory wizard):
// write `inventory_quantity` (+ `inventory_date`) on the quant, then call the recordset method
// `action_apply_inventory()`. Writing `inventory_quantity` alone does NOT take effect — confirmed
// live during research: several LAB/Stock quants had stale unapplied `inventory_quantity` values
// sitting in the DB from a prior manual count that was entered but never applied. This module
// always calls action_apply_inventory in the same request as the write, never leaves it pending.
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from './odoo';

const NO_MAIL_CONTEXT = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true };

let cachedLabLocationId: number | null = null;

async function getLabStockLocationId(): Promise<number> {
  if (cachedLabLocationId) return cachedLabLocationId;
  const whs = await odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=', 'LAB']]], { fields: ['lot_stock_id'], limit: 1 });
  const wh = whs[0];
  if (!wh?.lot_stock_id) throw new Error('Entrepôt LAB introuvable sur Odoo (code "LAB")');
  cachedLabLocationId = Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : wh.lot_stock_id;
  return cachedLabLocationId!;
}

/** Resolve product.product ids by default_code (SKU), batched — same pattern as odoo-mo-sync.ts. */
async function resolveProductsBySku(skus: string[]): Promise<Record<string, { id: number; name: string }>> {
  if (!skus.length) return {};
  const prods = await odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'name', 'default_code'], limit: 2000 });
  const map: Record<string, { id: number; name: string }> = {};
  for (const p of prods) if (p.default_code) map[p.default_code] = { id: p.id, name: p.name };
  return map;
}

export interface InventoryCountInput { sku: string; qtyCounted: number; }

export interface InventoryLineResult {
  sku: string;
  found: boolean;            // product exists on Odoo (default_code match)
  qtySystem: number | null;  // on-hand at LAB/Stock at the time of this call
  qtyCounted: number;
  diff: number | null;
  ok: boolean;
  error?: string;
}

export interface InventoryPushResult {
  ok: boolean;
  dryRun: boolean;
  lines: InventoryLineResult[];
  error?: string;
}

async function pushInventory(
  lines: InventoryCountInput[], inventoryDate: string, dryRun: boolean,
): Promise<InventoryPushResult> {
  if (!lines.length) return { ok: false, dryRun, lines: [], error: 'Aucune ligne comptée' };
  if (!dryRun && !odooWriteConfigured()) return { ok: false, dryRun, lines: [], error: 'Compte Odoo en écriture non configuré' };

  try {
    const locationId = await getLabStockLocationId();
    const skus = lines.map(l => l.sku);
    const productBySku = await resolveProductsBySku(skus);
    const foundIds = Object.values(productBySku).map(p => p.id);

    // Existing quants at LAB/Stock for these products (normally 1 per product; sum in case of lots).
    const quants = foundIds.length ? await odooExecute<any[]>('stock.quant', 'search_read',
      [[['product_id', 'in', foundIds], ['location_id', '=', locationId]]],
      { fields: ['id', 'product_id', 'quantity'] }) : [];
    const quantsByProductId: Record<number, { ids: number[]; qty: number }> = {};
    for (const q of quants) {
      const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
      const e = quantsByProductId[pid] ??= { ids: [], qty: 0 };
      e.ids.push(q.id); e.qty += Number(q.quantity ?? 0);
    }

    const results: InventoryLineResult[] = [];
    const toApplyQuantIds: number[] = [];

    for (const l of lines) {
      const prod = productBySku[l.sku];
      if (!prod) {
        results.push({ sku: l.sku, found: false, qtySystem: null, qtyCounted: l.qtyCounted, diff: null, ok: false, error: 'SKU introuvable sur Odoo (default_code)' });
        continue;
      }
      const existing = quantsByProductId[prod.id];
      const qtySystem = existing?.qty ?? 0;
      const diff = l.qtyCounted - qtySystem;

      if (dryRun) {
        results.push({ sku: l.sku, found: true, qtySystem, qtyCounted: l.qtyCounted, diff, ok: true });
        continue;
      }

      try {
        let quantId: number;
        if (existing?.ids.length) {
          // Multiple quants (rare, e.g. lots) — write the count on the first, leave the rest
          // untouched rather than guess how to split it; flagged in the line result.
          quantId = existing.ids[0];
          await odooExecuteWrite('stock.quant', 'write', [[quantId], {
            inventory_quantity: l.qtyCounted, inventory_date: inventoryDate,
          }], { context: NO_MAIL_CONTEXT });
        } else {
          quantId = await odooExecuteWrite<number>('stock.quant', 'create', [{
            product_id: prod.id, location_id: locationId,
            inventory_quantity: l.qtyCounted, inventory_date: inventoryDate,
          }], { context: NO_MAIL_CONTEXT });
        }
        toApplyQuantIds.push(quantId);
        results.push({
          sku: l.sku, found: true, qtySystem, qtyCounted: l.qtyCounted, diff, ok: true,
          error: (existing?.ids.length ?? 0) > 1
            ? `Plusieurs lots Odoo pour ce produit — seul le premier a été mis à jour (${existing!.ids.length} au total)`
            : undefined,
        });
      } catch (e: any) {
        results.push({ sku: l.sku, found: true, qtySystem, qtyCounted: l.qtyCounted, diff, ok: false, error: String(e?.message ?? e) });
      }
    }

    if (!dryRun && toApplyQuantIds.length) {
      try {
        await odooExecuteWrite('stock.quant', 'action_apply_inventory', [toApplyQuantIds], { context: NO_MAIL_CONTEXT });
      } catch (e: any) {
        // The write succeeded but applying it didn't — surface this on every line we just queued,
        // since those counts are now sitting unapplied in Odoo (the exact stale-data trap found
        // during research). Better to loudly flag it than silently leave it half-done.
        const msg = `Écrit mais non appliqué sur Odoo : ${String(e?.message ?? e)}`;
        for (const r of results) if (r.ok) { r.ok = false; r.error = r.error ? `${r.error} / ${msg}` : msg; }
      }
    }

    return { ok: true, dryRun, lines: results };
  } catch (e: any) {
    return { ok: false, dryRun, lines: [], error: String(e?.message ?? e) };
  }
}

export async function previewInventoryPush(lines: InventoryCountInput[]): Promise<InventoryPushResult> {
  return pushInventory(lines, '', true);
}

export async function applyInventoryPush(lines: InventoryCountInput[], inventoryDate: string): Promise<InventoryPushResult> {
  return pushInventory(lines, inventoryDate, false);
}
