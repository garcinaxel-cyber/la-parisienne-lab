// "Valider la livraison sur Odoo" (Axel, 2026-08-17) — the step after an assistant has checked
// every line of a delivery, validated the checklist itself, and printed the slip. Writes the
// delivered quantities back onto Odoo's stock.move lines and validates the picking, so Odoo's
// own stock/accounting reflects reality instead of staying frozen at the originally-requested
// quantities forever.
//
// REPLENISHMENT REQUESTS ONLY for this first pilot phase — sales orders (+ invoice creation)
// come later once this is proven end-to-end on a real order. Calling this for a sales_order
// order returns an explicit "not yet supported" error rather than silently doing nothing.
//
// DESIGN — kept deliberately SKU-aggregated on the delivery-check side (no schema change there,
// nothing about the existing screen changes). The only new logic lives here, at the final push:
// Odoo's CURRENT lines are fetched live at push time (never a stored line id from days ago, so
// there's no "did Odoo renumber this line" question to answer), and the checked total per SKU is
// redistributed across however many real Odoo lines that SKU has right now.
//   - 1 Odoo line for that SKU -> no ambiguity, write the checked qty directly.
//   - >1 Odoo lines, checked total == sum of their expected quantities -> no ambiguity either,
//     each line gets its own original qty back untouched.
//   - >1 Odoo lines AND a shortfall/excess -> genuinely ambiguous (Axel, 2026-08-17: confirmed
//     rare — 2 occurrences out of 216 order×SKU pairs across the last 15 REP orders, both
//     packaging items with one line per note/flavor, e.g. REP/2026/01076's stickers). Reported
//     back as `needsSplit` instead of guessed at; the caller must re-invoke with an explicit
//     `splits` entry for that SKU before any write happens. Axel confirmed assistants always know
//     which physical line fell short — no "distribute proportionally" fallback was wanted.
//
// DRY RUN — always performs the "confirm the order if still draft" step for real (action_submit/
// action_approve are already proven safe, in production daily via the J+1 lock cron — same-day
// deliveries are explicitly OUT of that cron's scope, so an order reaching delivery-check same-day
// can genuinely still be in draft, this isn't a hypothetical). What dryRun actually gates is only
// the quantity write + picking validation — the two actions that have never been exercised via
// this API account before and need a live, reviewed first run.
import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

export interface DeliveryValidateLine { sku: string; product_name_vi: string; qty_checked: number; qty_expected: number }

export interface NeedsSplitEntry {
  sku: string;
  product_name_vi: string;
  qtyChecked: number; // must be redistributed across the lines below, summing to exactly this
  lines: { moveId: number; note: string | null; expectedQty: number }[];
}

export interface SplitInput { sku: string; allocations: { moveId: number; qty: number }[] }

export interface PlannedWrite { sku: string; moveId: number; note: string | null; expectedQty: number; deliverQty: number }

export interface DeliveryValidateResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  needsSplit?: NeedsSplitEntry[];
  orderConfirmed?: boolean; // true if this call had to action_submit/action_approve a draft order
  alreadyDoneOnOdoo?: boolean; // picking was already validated by someone else, nothing to do
  pickingId?: number;
  pickingName?: string;
  plan?: PlannedWrite[]; // what would be / was written per stock.move
}

// Odoo's stock.picking.state values that mean "already fully processed" — never re-validate.
const DONE_STATES = new Set(['done']);
const BLOCKED_STATES = new Set(['cancel']);

export async function validateReplenishmentDeliveryOnOdoo(
  supabase: SupabaseClient,
  orderRef: string,
  sourceType: string,
  checklistLines: DeliveryValidateLine[],
  dryRun: boolean,
  splits: SplitInput[] = [],
): Promise<DeliveryValidateResult> {
  if (sourceType !== 'replenishment') {
    return { ok: false, dryRun, error: 'Validation Odoo pas encore disponible pour les commandes clients (sales order) — REP uniquement pour le moment.' };
  }
  if (!odooWriteConfigured()) {
    return { ok: false, dryRun, error: 'Compte Odoo en écriture non configuré' };
  }
  if (!checklistLines.length) {
    return { ok: false, dryRun, error: 'Aucune ligne à valider' };
  }

  try {
    const reqs = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
      [[['name', '=', orderRef]]], { fields: ['id', 'name', 'state', 'delivery_picking_ids'] });
    const req = reqs[0];
    if (!req) return { ok: false, dryRun, error: `Commande ${orderRef} introuvable dans Odoo` };

    // Same two-step transition as lockTomorrowOrders (odoo-order-lock.ts) — action_submit is
    // only valid from 'draft', action_approve only from 'submitted'. Performed for real even in
    // dry-run mode: it's already proven safe in production (the J+1 cron does this daily), and
    // we need the order actually approved to even discover its delivery picking.
    let orderConfirmed = false;
    if (req.state === 'draft' || req.state === 'submitted') {
      if (req.state === 'draft') await odooExecuteWrite('stock.replenishment.request', 'action_submit', [[req.id]]);
      await odooExecuteWrite('stock.replenishment.request', 'action_approve', [[req.id]]);
      orderConfirmed = true;
      const refreshed = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
        [[['id', '=', req.id]]], { fields: ['id', 'name', 'state', 'delivery_picking_ids'] });
      req.state = refreshed[0]?.state;
      req.delivery_picking_ids = refreshed[0]?.delivery_picking_ids ?? [];
    }

    const pickingIds: number[] = req.delivery_picking_ids ?? [];
    if (!pickingIds.length) {
      return { ok: false, dryRun, orderConfirmed, error: `Aucun bon de livraison (picking) Odoo trouvé pour ${orderRef} — peut nécessiter une vérification manuelle dans Odoo.` };
    }
    // In practice a REP has exactly one delivery picking; if Odoo ever attaches more than one,
    // fail loudly instead of guessing which one to act on.
    if (pickingIds.length > 1) {
      return { ok: false, dryRun, orderConfirmed, error: `${orderRef} a ${pickingIds.length} bons de livraison Odoo — cas non géré, vérification manuelle nécessaire.` };
    }
    const pickingId = pickingIds[0];

    const pickings = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['id', '=', pickingId]]], { fields: ['id', 'name', 'state'] });
    const picking = pickings[0];
    if (!picking) return { ok: false, dryRun, orderConfirmed, error: `Picking Odoo ${pickingId} introuvable` };
    if (DONE_STATES.has(picking.state)) {
      return { ok: true, dryRun, orderConfirmed, alreadyDoneOnOdoo: true, pickingId, pickingName: picking.name };
    }
    if (BLOCKED_STATES.has(picking.state)) {
      return { ok: false, dryRun, orderConfirmed, error: `Picking Odoo ${picking.name} est annulé — vérification manuelle nécessaire.` };
    }

    const moves = await odooExecute<any[]>('stock.move', 'search_read',
      [[['picking_id', '=', pickingId]]],
      { fields: ['id', 'product_id', 'product_uom_qty', 'replenishment_line_id'] });
    const productIds = Array.from(new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))) as number[];
    const products = productIds.length
      ? await odooExecute<any[]>('product.product', 'read', [productIds], { fields: ['default_code'] })
      : [];
    const skuByProductId: Record<number, string> = {};
    for (const p of products) skuByProductId[p.id] = p.default_code || '';

    const lineIds = Array.from(new Set(moves.map(m => m.replenishment_line_id?.[0]).filter(Boolean))) as number[];
    const reqLines = lineIds.length
      ? await odooExecute<any[]>('stock.replenishment.request.line', 'read', [lineIds], { fields: ['note'] })
      : [];
    const noteByLineId: Record<number, string | null> = {};
    for (const l of reqLines) noteByLineId[l.id] = (typeof l.note === 'string' && l.note.trim()) ? l.note.trim() : null;

    const movesBySku: Record<string, { moveId: number; expectedQty: number; note: string | null }[]> = {};
    for (const m of moves) {
      const sku = skuByProductId[m.product_id?.[0]];
      if (!sku) continue;
      (movesBySku[sku] ??= []).push({
        moveId: m.id, expectedQty: Number(m.product_uom_qty ?? 0),
        note: m.replenishment_line_id ? noteByLineId[m.replenishment_line_id[0]] ?? null : null,
      });
    }

    const splitBySku: Record<string, SplitInput> = {};
    for (const s of splits) splitBySku[s.sku] = s;

    const plan: PlannedWrite[] = [];
    const needsSplit: NeedsSplitEntry[] = [];
    const mismatches: string[] = [];

    for (const l of checklistLines) {
      const odooLines = movesBySku[l.sku];
      if (!odooLines?.length) { mismatches.push(l.sku); continue; }

      if (odooLines.length === 1) {
        plan.push({ sku: l.sku, moveId: odooLines[0].moveId, note: odooLines[0].note, expectedQty: odooLines[0].expectedQty, deliverQty: l.qty_checked });
        continue;
      }

      const expectedSum = odooLines.reduce((s, o) => s + o.expectedQty, 0);
      if (l.qty_checked === expectedSum) {
        for (const o of odooLines) plan.push({ sku: l.sku, moveId: o.moveId, note: o.note, expectedQty: o.expectedQty, deliverQty: o.expectedQty });
        continue;
      }

      const provided = splitBySku[l.sku];
      if (!provided) {
        needsSplit.push({ sku: l.sku, product_name_vi: l.product_name_vi, qtyChecked: l.qty_checked, lines: odooLines.map(o => ({ moveId: o.moveId, note: o.note, expectedQty: o.expectedQty })) });
        continue;
      }
      const providedSum = provided.allocations.reduce((s, a) => s + a.qty, 0);
      if (providedSum !== l.qty_checked) {
        return { ok: false, dryRun, orderConfirmed, error: `Répartition invalide pour ${l.sku} : la somme (${providedSum}) ne correspond pas au total coché (${l.qty_checked}).` };
      }
      for (const o of odooLines) {
        const alloc = provided.allocations.find(a => a.moveId === o.moveId);
        if (!alloc) return { ok: false, dryRun, orderConfirmed, error: `Répartition incomplète pour ${l.sku} — ligne Odoo ${o.moveId} manquante.` };
        plan.push({ sku: l.sku, moveId: o.moveId, note: o.note, expectedQty: o.expectedQty, deliverQty: alloc.qty });
      }
    }

    if (mismatches.length) {
      return { ok: false, dryRun, orderConfirmed, error: `Produits cochés introuvables sur le picking Odoo : ${mismatches.join(', ')} — vérification manuelle nécessaire.` };
    }
    if (needsSplit.length) {
      return { ok: false, dryRun, orderConfirmed, needsSplit, pickingId, pickingName: picking.name };
    }

    if (dryRun) {
      return { ok: true, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan };
    }

    // Real writes from here — quantity per move, then validate the picking without ever
    // creating a backorder (Axel, 2026-08-17: "on ne fait jamais de back order, on valide
    // simplement la quantité livrée"). NOT yet live-verified against this Odoo version's exact
    // backorder-skip mechanism — this is precisely what the first pilot order is for.
    for (const p of plan) {
      await odooExecuteWrite('stock.move', 'write', [[p.moveId], { quantity: p.deliverQty }]);
    }
    const validateRes = await odooExecuteWrite('stock.picking', 'button_validate', [[pickingId]], {
      context: { skip_backorder: true, button_validate_picking_ids: [pickingId] },
    });
    // A plain `true` means Odoo validated cleanly. Anything else (an action dict, a wizard
    // reference) means our skip_backorder context didn't fully suppress the interactive flow —
    // surface it raw rather than assume success, since we can't drive a wizard headlessly here.
    if (validateRes !== true) {
      return { ok: false, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan, error: `Odoo a renvoyé une réponse inattendue à la validation : ${JSON.stringify(validateRes)} — le picking n'est peut-être pas validé, vérifier manuellement dans Odoo.` };
    }

    return { ok: true, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan };
  } catch (e: any) {
    return { ok: false, dryRun, error: String(e?.message ?? e) };
  }
}
