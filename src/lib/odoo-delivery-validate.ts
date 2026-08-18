// "Valider la livraison sur Odoo" (Axel, 2026-08-17) — the step after an assistant has checked
// every line of a delivery, validated the checklist itself, and printed the slip. Writes the
// delivered quantities back onto Odoo's stock.move lines and validates the picking, so Odoo's
// own stock/accounting reflects reality instead of staying frozen at the originally-requested
// quantities forever.
//
// REPLENISHMENT REQUESTS proven first (2026-08-17/18, several live orders, 3 rounds of fixes —
// see NO_MAIL_CONTEXT and writeQuantitiesAndValidatePicking's doc comments below for the full
// history). SALES ORDERS added 2026-08-18 once REP was stable, reusing the exact same
// plan-building + write/validate logic — only the "which Odoo model, which line-link field, which
// notes" parts differ, plus one extra step: create a regular (delivered-qty) invoice, left in
// draft, after the picking validates (Axel, 2026-08-17: "pour les sales order je veux aussi qu
// après avoir validé la delivery cela crée l'invoice (regular invoice toujours) et la laisse en
// statut draft").
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
//     rare on REP — 2 occurrences out of 216 order×SKU pairs across the last 15 REP orders, both
//     packaging items with one line per note/flavor). Reported back as `needsSplit` instead of
//     guessed at; the caller must re-invoke with an explicit `splits` entry for that SKU before
//     any write happens. Axel confirmed assistants always know which physical line fell short —
//     no "distribute proportionally" fallback was wanted.
//
// DRY RUN — always performs the "confirm the order if still draft" step for real (REP's
// action_submit/action_approve and SO's action_confirm are already proven safe, in production
// daily via the J+1 lock cron — same-day deliveries are explicitly OUT of that cron's scope, so
// an order reaching delivery-check same-day can genuinely still be in draft, this isn't a
// hypothetical). What dryRun actually gates is only the quantity write + picking validation (and,
// for SO, invoice creation) — the parts that write real business data.
import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

// Every write call in this file passes this context — Odoo's mail module posts a tracked-field
// chatter message (and tries to notify followers by email) whenever a tracked field actually
// changes value (e.g. state on action_submit/approve/action_confirm, quantity on stock.move). The
// API write account's linked partner had no email configured at first, so that notification
// attempt crashed the whole call with "Unable to send message, please configure the sender's
// email address" — discovered 2026-08-18 testing the first live delivery-validation batch: every
// order that still needed a state-transition method (still draft/submitted, same-day, outside the
// J+1 cron's scope) hit this, while already-approved orders (no state change -> no tracked
// message) didn't. Root cause was actually TWO-fold: (1) the API account genuinely had no email
// configured in Odoo (fixed by Axel directly in Odoo settings), (2) even after that, an explicit
// message_post() inside button_validate's own logic (not a tracked-field message, so
// tracking_disable alone didn't cover it) still tried to send synchronously — mail_notify_force_
// send=false defers that to Odoo's own mail queue instead of blocking the call. Both fixes kept
// here belt-and-suspenders since (2) could in principle still bite even with (1) fixed.
const NO_MAIL_CONTEXT = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };

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
  orderConfirmed?: boolean; // true if this call had to action_submit/action_approve/action_confirm a draft order
  alreadyDoneOnOdoo?: boolean; // picking was already validated by someone else, nothing to write there
  pickingId?: number;
  pickingName?: string;
  plan?: PlannedWrite[]; // what would be / was written per stock.move
  // Set when button_validate returned `true` (no error) but Odoo created a backorder picking
  // anyway — belt-and-suspenders after two different context-flag attempts each failed silently
  // once already (2026-08-18, 5 orders total). Still ok:true (the delivered quantities DID get
  // written correctly), but surfaced so it's never invisible again — Axel wants zero backorders,
  // full stop. Should be rare now that the write step also shrinks product_uom_qty to eliminate
  // the shortfall itself, but kept as a safety net rather than assumed fixed.
  backorderWarning?: string;
  // Sales orders only, from here down.
  invoiceCreated?: boolean;
  invoiceName?: string;
  invoiceAlreadyExisted?: boolean; // a non-cancelled invoice already existed, nothing new created
  invoiceError?: string; // picking still validated fine even if this step failed — surfaced, not fatal
}

// Odoo's stock.picking.state values that mean "already fully processed" — never re-validate.
const DONE_STATES = new Set(['done']);
const BLOCKED_STATES = new Set(['cancel']);

type MoveInfo = { moveId: number; expectedQty: number; note: string | null };

// Shared by both REP and SO: redistribute each checklist line's checked total across however
// many real Odoo lines that SKU currently has. Pure function, no Odoo calls — see the file-level
// doc comment above for the exact 1-line / matching-sum / needs-split decision rules.
function buildPlan(
  checklistLines: DeliveryValidateLine[],
  movesBySku: Record<string, MoveInfo[]>,
  splits: SplitInput[],
): { plan: PlannedWrite[]; needsSplit: NeedsSplitEntry[]; mismatches: string[]; error: string | null } {
  const splitBySku: Record<string, SplitInput> = {};
  for (const s of splits) splitBySku[s.sku] = s;

  const plan: PlannedWrite[] = [];
  const needsSplit: NeedsSplitEntry[] = [];
  const mismatches: string[] = [];
  const empty = { plan: [], needsSplit: [], mismatches: [] };

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
      return { ...empty, error: `Répartition invalide pour ${l.sku} : la somme (${providedSum}) ne correspond pas au total coché (${l.qty_checked}).` };
    }
    for (const o of odooLines) {
      const alloc = provided.allocations.find(a => a.moveId === o.moveId);
      if (!alloc) return { ...empty, error: `Répartition incomplète pour ${l.sku} — ligne Odoo ${o.moveId} manquante.` };
      plan.push({ sku: l.sku, moveId: o.moveId, note: o.note, expectedQty: o.expectedQty, deliverQty: alloc.qty });
    }
  }

  return { plan, needsSplit, mismatches, error: null };
}

// Shared by both REP and SO: write the delivered quantity per move, then validate the picking.
//
// BUG FOUND 2026-08-18, THIRD occurrence (REP/2026/01072, after skip_backorder alone, then
// skip_backorder+cancel_backorder, both failed to stop Odoo creating a backorder): trying to
// suppress backorder creation purely via button_validate's context has proven unreliable on this
// Odoo version/custom module — couldn't fully diagnose the exact internal reason each time since
// Axel deletes the extra picking right away (understandably), so the evidence is gone before it
// can be inspected. Switched approach: instead of asking Odoo not to create a backorder for the
// shortfall, remove the shortfall itself. Any move delivered LESS than its demanded qty also gets
// its product_uom_qty (the "demanded" quantity) reduced down to match what was actually
// delivered — same as manually editing the Demand column in Odoo's UI to close a partial delivery
// cleanly. With demand == done on every move, there's structurally nothing left for Odoo to spin
// into a backorder, regardless of which context flag it does or doesn't respect. Only touches the
// stock.move (this specific delivery), never the original demand line (stock.replenishment.
// request.line / sale.order.line) the order itself was built from.
//
// skip_backorder + cancel_backorder are still passed too (harmless, may still help Odoo skip the
// wizard cleanly), and a post-validate check re-reads the picking list to confirm nothing new
// showed up anyway — belt-and-suspenders after two earlier fixes each silently failed once.
async function writeQuantitiesAndValidatePicking(
  pickingId: number, plan: PlannedWrite[],
): Promise<{ ok: true; backorderWarning?: string } | { ok: false; error: string }> {
  for (const p of plan) {
    const patch: Record<string, unknown> = { quantity: p.deliverQty };
    if (p.deliverQty < p.expectedQty) patch.product_uom_qty = p.deliverQty;
    await odooExecuteWrite('stock.move', 'write', [[p.moveId], patch], { context: NO_MAIL_CONTEXT });
  }
  const validateRes = await odooExecuteWrite('stock.picking', 'button_validate', [[pickingId]], {
    context: { skip_backorder: true, cancel_backorder: true, button_validate_picking_ids: [pickingId], ...NO_MAIL_CONTEXT },
  });
  // A plain `true` means Odoo validated cleanly. Anything else (an action dict, a wizard
  // reference) means our skip_backorder context didn't fully suppress the interactive flow —
  // surface it raw rather than assume success, since we can't drive a wizard headlessly here.
  if (validateRes !== true) {
    return { ok: false, error: `Odoo a renvoyé une réponse inattendue à la validation : ${JSON.stringify(validateRes)} — le picking n'est peut-être pas validé, vérifier manuellement dans Odoo.` };
  }
  return { ok: true };
}

async function resolveSkuByProductId(productIds: number[]): Promise<Record<number, string>> {
  const products = productIds.length
    ? await odooExecute<any[]>('product.product', 'read', [productIds], { fields: ['default_code'] })
    : [];
  const skuByProductId: Record<number, string> = {};
  for (const p of products) skuByProductId[p.id] = p.default_code || '';
  return skuByProductId;
}

export async function validateDeliveryOnOdoo(
  supabase: SupabaseClient,
  orderRef: string,
  sourceType: string,
  checklistLines: DeliveryValidateLine[],
  dryRun: boolean,
  splits: SplitInput[] = [],
): Promise<DeliveryValidateResult> {
  if (sourceType !== 'replenishment' && sourceType !== 'sales_order') {
    return { ok: false, dryRun, error: `Type de commande non géré : ${sourceType}` };
  }
  if (!odooWriteConfigured()) {
    return { ok: false, dryRun, error: 'Compte Odoo en écriture non configuré' };
  }
  if (!checklistLines.length) {
    return { ok: false, dryRun, error: 'Aucune ligne à valider' };
  }

  try {
    return sourceType === 'replenishment'
      ? await validateReplenishment(orderRef, checklistLines, dryRun, splits)
      : await validateSalesOrder(orderRef, checklistLines, dryRun, splits);
  } catch (e: any) {
    return { ok: false, dryRun, error: String(e?.message ?? e) };
  }
}

async function validateReplenishment(
  orderRef: string, checklistLines: DeliveryValidateLine[], dryRun: boolean, splits: SplitInput[],
): Promise<DeliveryValidateResult> {
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
    if (req.state === 'draft') await odooExecuteWrite('stock.replenishment.request', 'action_submit', [[req.id]], { context: NO_MAIL_CONTEXT });
    await odooExecuteWrite('stock.replenishment.request', 'action_approve', [[req.id]], { context: NO_MAIL_CONTEXT });
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
  const skuByProductId = await resolveSkuByProductId(Array.from(new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))) as number[]);

  const lineIds = Array.from(new Set(moves.map(m => m.replenishment_line_id?.[0]).filter(Boolean))) as number[];
  const reqLines = lineIds.length
    ? await odooExecute<any[]>('stock.replenishment.request.line', 'read', [lineIds], { fields: ['note'] })
    : [];
  const noteByLineId: Record<number, string | null> = {};
  for (const l of reqLines) noteByLineId[l.id] = (typeof l.note === 'string' && l.note.trim()) ? l.note.trim() : null;

  const movesBySku: Record<string, MoveInfo[]> = {};
  for (const m of moves) {
    const sku = skuByProductId[m.product_id?.[0]];
    if (!sku) continue;
    (movesBySku[sku] ??= []).push({
      moveId: m.id, expectedQty: Number(m.product_uom_qty ?? 0),
      note: m.replenishment_line_id ? noteByLineId[m.replenishment_line_id[0]] ?? null : null,
    });
  }

  const built = buildPlan(checklistLines, movesBySku, splits);
  if (built.error) return { ok: false, dryRun, orderConfirmed, error: built.error };
  const { plan, needsSplit, mismatches } = built;

  if (mismatches.length) {
    return { ok: false, dryRun, orderConfirmed, error: `Produits cochés introuvables sur le picking Odoo : ${mismatches.join(', ')} — vérification manuelle nécessaire.` };
  }
  if (needsSplit.length) {
    return { ok: false, dryRun, orderConfirmed, needsSplit, pickingId, pickingName: picking.name };
  }
  if (dryRun) {
    return { ok: true, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan };
  }

  const written = await writeQuantitiesAndValidatePicking(pickingId, plan);
  if (!written.ok) {
    return { ok: false, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan, error: written.error };
  }

  // Verify no backorder actually got created, rather than trust button_validate's `true` return
  // at face value — that's exactly what silently let orders through with an unwanted backorder
  // twice already today. The shortfall-elimination write above should prevent it structurally now.
  let backorderWarning: string | undefined;
  const afterReq = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
    [[['id', '=', req.id]]], { fields: ['delivery_picking_ids'] });
  const newPickingIds = ((afterReq[0]?.delivery_picking_ids ?? []) as number[]).filter(id => id !== pickingId);
  if (newPickingIds.length) {
    backorderWarning = `Odoo a quand même créé ${newPickingIds.length > 1 ? 'des bons de livraison' : 'un bon de livraison'} supplémentaire(s) (${newPickingIds.join(', ')}) — à supprimer manuellement dans Odoo si tu ne veux pas de reliquat ouvert.`;
  }

  return { ok: true, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan, backorderWarning };
}

async function validateSalesOrder(
  orderRef: string, checklistLines: DeliveryValidateLine[], dryRun: boolean, splits: SplitInput[],
): Promise<DeliveryValidateResult> {
  const orders = await odooExecute<any[]>('sale.order', 'search_read',
    [[['name', '=', orderRef]]], { fields: ['id', 'name', 'state', 'picking_ids', 'invoice_ids', 'invoice_status'] });
  const so = orders[0];
  if (!so) return { ok: false, dryRun, error: `Commande ${orderRef} introuvable dans Odoo` };

  // Same reasoning as REP's confirm step — action_confirm is already proven safe daily via the
  // J+1 lock cron (odoo-order-lock.ts), same-day orders can genuinely still be in draft/sent.
  let orderConfirmed = false;
  if (so.state === 'draft' || so.state === 'sent') {
    await odooExecuteWrite('sale.order', 'action_confirm', [[so.id]], { context: NO_MAIL_CONTEXT });
    orderConfirmed = true;
    const refreshed = await odooExecute<any[]>('sale.order', 'search_read',
      [[['id', '=', so.id]]], { fields: ['id', 'name', 'state', 'picking_ids', 'invoice_ids', 'invoice_status'] });
    so.state = refreshed[0]?.state;
    so.picking_ids = refreshed[0]?.picking_ids ?? [];
    so.invoice_ids = refreshed[0]?.invoice_ids ?? [];
    so.invoice_status = refreshed[0]?.invoice_status;
  }

  const pickingIds: number[] = so.picking_ids ?? [];
  if (!pickingIds.length) {
    return { ok: false, dryRun, orderConfirmed, error: `Aucun bon de livraison (picking) Odoo trouvé pour ${orderRef} — peut nécessiter une vérification manuelle dans Odoo.` };
  }
  if (pickingIds.length > 1) {
    return { ok: false, dryRun, orderConfirmed, error: `${orderRef} a ${pickingIds.length} bons de livraison Odoo — cas non géré, vérification manuelle nécessaire.` };
  }
  const pickingId = pickingIds[0];

  const pickings = await odooExecute<any[]>('stock.picking', 'search_read',
    [[['id', '=', pickingId]]], { fields: ['id', 'name', 'state'] });
  const picking = pickings[0];
  if (!picking) return { ok: false, dryRun, orderConfirmed, error: `Picking Odoo ${pickingId} introuvable` };
  if (BLOCKED_STATES.has(picking.state)) {
    return { ok: false, dryRun, orderConfirmed, error: `Picking Odoo ${picking.name} est annulé — vérification manuelle nécessaire.` };
  }
  // Unlike REP, a picking already 'done' doesn't mean there's nothing left to do here — the
  // invoice step below still needs to run if it hasn't yet (e.g. a previous attempt validated
  // the picking but failed before creating the invoice). So this only skips the write/validate
  // block, it doesn't return early.
  const alreadyDoneOnOdoo = DONE_STATES.has(picking.state);

  // Resolved early (read-only, safe during dryRun too) so the preview can correctly tell the
  // assistant whether clicking "Confirmer" will still do something even when the picking is
  // already done — e.g. a retry where the delivery validated fine last time but invoice creation
  // failed. Without this, alreadyDoneOnOdoo alone would make the preview say "rien à faire de
  // plus" while a real confirm click would actually go create the missing invoice.
  const beforeInvoiceIds: number[] = so.invoice_ids ?? [];
  const existingInvoices = beforeInvoiceIds.length
    ? await odooExecute<any[]>('account.move', 'search_read',
        [[['id', 'in', beforeInvoiceIds], ['state', '!=', 'cancel']]], { fields: ['id', 'name'] })
    : [];
  const invoiceAlreadyExisted = existingInvoices.length > 0;

  const moves = await odooExecute<any[]>('stock.move', 'search_read',
    [[['picking_id', '=', pickingId]]],
    { fields: ['id', 'product_id', 'product_uom_qty', 'sale_line_id'] });
  const skuByProductId = await resolveSkuByProductId(Array.from(new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))) as number[]);

  // Sales-order notes don't live on a dedicated field like REP's — a salesperson can attach one
  // as its OWN line (display_type='line_note') right under a product line, attributed by display
  // order (sequence). Same attribution logic as odoo-sync.ts's SO import, reused here so the
  // split-disambiguation UI shows the same note an assistant already recognizes from checking.
  const allSoLines = await odooExecute<any[]>('sale.order.line', 'search_read',
    [[['order_id', '=', so.id]]], { fields: ['product_id', 'sequence', 'display_type', 'name'] });
  allSoLines.sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const attachedNoteByLineId: Record<number, string> = {};
  let lastProductLineId: number | null = null;
  for (const l of allSoLines) {
    if (l.display_type === 'line_note') {
      const text = String(l.name ?? '').trim();
      if (lastProductLineId != null && text) {
        attachedNoteByLineId[lastProductLineId] = attachedNoteByLineId[lastProductLineId]
          ? `${attachedNoteByLineId[lastProductLineId]} / ${text}` : text;
      }
      continue;
    }
    if (!l.display_type) lastProductLineId = l.id;
  }

  const movesBySku: Record<string, MoveInfo[]> = {};
  for (const m of moves) {
    const sku = skuByProductId[m.product_id?.[0]];
    if (!sku) continue;
    (movesBySku[sku] ??= []).push({
      moveId: m.id, expectedQty: Number(m.product_uom_qty ?? 0),
      note: m.sale_line_id ? attachedNoteByLineId[m.sale_line_id[0]] ?? null : null,
    });
  }

  const built = buildPlan(checklistLines, movesBySku, splits);
  if (built.error) return { ok: false, dryRun, orderConfirmed, error: built.error };
  const { plan, needsSplit, mismatches } = built;

  if (mismatches.length) {
    return { ok: false, dryRun, orderConfirmed, error: `Produits cochés introuvables sur le picking Odoo : ${mismatches.join(', ')} — vérification manuelle nécessaire.` };
  }
  if (needsSplit.length) {
    return { ok: false, dryRun, orderConfirmed, needsSplit, pickingId, pickingName: picking.name };
  }
  if (dryRun) {
    return {
      ok: true, dryRun, orderConfirmed, alreadyDoneOnOdoo, pickingId, pickingName: picking.name, plan,
      invoiceAlreadyExisted, invoiceName: existingInvoices[0]?.name,
    };
  }

  let backorderWarning: string | undefined;
  if (!alreadyDoneOnOdoo) {
    const written = await writeQuantitiesAndValidatePicking(pickingId, plan);
    if (!written.ok) {
      return { ok: false, dryRun, orderConfirmed, pickingId, pickingName: picking.name, plan, error: written.error };
    }
    const afterSo = await odooExecute<any[]>('sale.order', 'search_read',
      [[['id', '=', so.id]]], { fields: ['picking_ids'] });
    const newPickingIds = ((afterSo[0]?.picking_ids ?? []) as number[]).filter(id => id !== pickingId);
    if (newPickingIds.length) {
      backorderWarning = `Odoo a quand même créé ${newPickingIds.length > 1 ? 'des bons de livraison' : 'un bon de livraison'} supplémentaire(s) (${newPickingIds.join(', ')}) — à supprimer manuellement dans Odoo si tu ne veux pas de reliquat ouvert.`;
    }
  }

  // Invoice creation — sales orders only (Axel, 2026-08-17). "Regular invoice" (advance_payment_
  // method: 'delivered') is the same option as the "Create Invoice" button's default in Odoo's
  // own UI: bills whatever is currently invoiceable (delivered-qty products included, since
  // invoice_policy is 'delivery' here — confirmed live earlier) and lands as a draft account.move,
  // never posted by us. Idempotent: if a non-cancelled invoice already existed BEFORE this call
  // (checked above, before the dryRun return), skip creating a second one — this branch can be
  // re-entered (e.g. a retry after the picking validated fine but this step failed the first
  // time), and a duplicate invoice would be a real accounting mistake, not just a cosmetic one.
  if (invoiceAlreadyExisted) {
    return {
      ok: true, dryRun, orderConfirmed, alreadyDoneOnOdoo, pickingId, pickingName: picking.name, plan, backorderWarning,
      invoiceAlreadyExisted: true, invoiceName: existingInvoices[0].name,
    };
  }

  let invoiceCreated = false, invoiceName: string | undefined, invoiceError: string | undefined;
  try {
    const wizardId = await odooExecuteWrite<number>('sale.advance.payment.inv', 'create',
      [{ advance_payment_method: 'delivered', sale_order_ids: [[6, 0, [so.id]]] }],
      { context: { active_ids: [so.id], active_model: 'sale.order', ...NO_MAIL_CONTEXT } });
    await odooExecuteWrite('sale.advance.payment.inv', 'create_invoices', [[wizardId]],
      { context: { active_ids: [so.id], active_model: 'sale.order', ...NO_MAIL_CONTEXT } });
    const afterSo = await odooExecute<any[]>('sale.order', 'search_read',
      [[['id', '=', so.id]]], { fields: ['invoice_ids'] });
    const newInvoiceIds = ((afterSo[0]?.invoice_ids ?? []) as number[]).filter(id => !beforeInvoiceIds.includes(id));
    if (newInvoiceIds.length) {
      const created = await odooExecute<any[]>('account.move', 'read', [newInvoiceIds], { fields: ['name', 'state'] });
      invoiceCreated = true;
      invoiceName = created[0]?.name;
    } else {
      invoiceError = "L'écriture de facturation n'a rien créé — vérifier manuellement sur Odoo (peut-être rien à facturer).";
    }
  } catch (e: any) {
    invoiceError = `Livraison validée sur Odoo, mais la création de la facture a échoué : ${String(e?.message ?? e)} — à créer manuellement sur Odoo (bouton "Créer facture", type "Facture normale").`;
  }

  return {
    ok: true, dryRun, orderConfirmed, alreadyDoneOnOdoo, pickingId, pickingName: picking.name, plan, backorderWarning,
    invoiceCreated, invoiceName, invoiceError,
  };
}
