import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

// Read-only diagnostic (2026-08-21) — see route comment. Introspects stock.move's actual field
// names (fields_get) plus the move_raw_ids values for one MO, so the real "how much was
// consumed" field can be identified and force-set before button_mark_done, instead of guessing.
export interface MoInspectResult {
  mo: { id: number; name: string; state: string; product_qty: number; qty_producing: number; move_raw_ids: number[]; move_finished_ids: number[] } | null;
  moveFields: string[];
  moves: any[];
  finishedMoves: any[];
  moveLines: any[];
  error?: string;
}

// 2026-08-21 — extended to also read move_line_ids: the mrp.consumption.warning wizard computes
// "consumed" from these, not from stock.move.quantity — a move with no move_line_ids (never
// reserved, e.g. negative on-hand) shows 0 consumed no matter what we write on the move header.
// Also pulls location_id/location_dest_id/product_uom so a move line could be constructed if
// none exist yet.
export async function inspectMO(moId: number): Promise<MoInspectResult> {
  const res: MoInspectResult = { mo: null, moveFields: [], moves: [], finishedMoves: [], moveLines: [] };
  try {
    const mos = await odooExecute<any[]>('mrp.production', 'search_read',
      [[['id', '=', moId]]], { fields: ['id', 'name', 'state', 'product_qty', 'qty_producing', 'move_raw_ids', 'move_finished_ids'] });
    if (!mos.length) { res.error = 'MO not found'; return res; }
    res.mo = mos[0];
    const moveIds: number[] = mos[0].move_raw_ids || [];
    const finishedIds: number[] = mos[0].move_finished_ids || [];

    const fieldsMeta = await odooExecute<Record<string, any>>('stock.move', 'fields_get', [], { attributes: ['string', 'type'] });
    const candidateFields = Object.keys(fieldsMeta).filter(f => /qty|quant/i.test(f));
    res.moveFields = candidateFields;

    const selectFields = Array.from(new Set(['id', 'product_id', 'state', 'product_uom_qty', 'product_uom', 'location_id', 'location_dest_id', 'picking_id', 'move_line_ids', ...candidateFields]));
    if (moveIds.length) {
      res.moves = await odooExecute<any[]>('stock.move', 'search_read', [[['id', 'in', moveIds]]], { fields: selectFields });
    }
    if (finishedIds.length) {
      res.finishedMoves = await odooExecute<any[]>('stock.move', 'search_read', [[['id', 'in', finishedIds]]], { fields: selectFields });
    }
    const allMoveLineIds: number[] = [...res.moves, ...res.finishedMoves].flatMap((m: any) => m.move_line_ids || []);
    if (allMoveLineIds.length) {
      res.moveLines = await odooExecute<any[]>('stock.move.line', 'search_read',
        [[['id', 'in', allMoveLineIds]]], { fields: ['id', 'move_id', 'product_id', 'quantity', 'location_id', 'location_dest_id', 'lot_id', 'picked', 'state'] });
    }
  } catch (e: any) {
    res.error = String(e?.message ?? e);
  }
  return res;
}

// Read-only diagnostic (2026-08-21) — Axel confirmed via screen recording + screenshots that
// typing into the header "Quantity" field in the Odoo UI is what cascades the correct amount
// onto every component line (all matching "To Consume", "Consumed" ticked) — a plain write() on
// qty_producing does NOT reproduce this (confirmed live: quantity stayed 0 on MO 38321/38324
// after write() alone). That cascade is a client-side @api.onchange handler in Odoo, which never
// runs on a plain ORM write — it only runs when the web client explicitly calls Odoo's generic
// 'onchange' RPC method (this is how every Odoo form view keeps derived fields in sync as you
// type, before you hit save). Testing that method here, read-only, before wiring it into
// produceMOs — no writes happen in this function.
export async function testOnchange(moId: number, qtyProducing: number): Promise<any> {
  const mos = await odooExecute<any[]>('mrp.production', 'search_read',
    [[['id', '=', moId]]], { fields: ['id', 'product_qty', 'qty_producing', 'move_raw_ids'] });
  if (!mos.length) return { error: 'MO not found' };
  const values = { ...mos[0], qty_producing: qtyProducing };
  delete (values as any).id;
  const result = await odooExecute<any>('mrp.production', 'onchange',
    [[moId], values, 'qty_producing', { qty_producing: '1', move_raw_ids: '1' }]);
  return result;
}

export interface MoConfirmResult {
  date: string;
  origin: string;
  eligible: number;
  bypassed: { id: number; name: string }[];
  confirmed: { id: number; name: string }[];
  errors: { id: number; name: string; error: string }[];
}

// Confirm the day's remaining DRAFT MOs once production is over for that lab-day (called once
// daily by pg_cron, after the hourly sync's active window closes — see lab_v30_mo_confirm_cron.sql).
// Confirming doesn't break same-day quantity deltas either way: syncStockToOdoo (odoo-mo-sync.ts)
// never touches a confirmed MO, it just opens a fresh small draft for any late addition — so
// running this once at end-of-day rather than per-transfer just avoids fragmenting one product's
// day into several separately-confirmed MOs.
//
// Scoped strictly to THIS lab-day's origin — never sweeps other days' leftover drafts. A draft
// left over from a past day (e.g. a very late/forgotten stock-transfer) is deliberately NOT
// auto-confirmed here: some of those are drafts on purpose because they were never meant to be
// accepted as-is (2026-08-05, explicit call — don't risk auto-confirming an old MO nobody reviewed).
//
// Semi-finished components: this Odoo instance has a custom "Auto Produce" mechanism — an MO
// whose raw materials include a semi-finished product (itself has a BOM) needs "Auto Produce"
// ticked on that line BEFORE confirming, otherwise Odoo confirms the parent MO but never spawns
// the child MO that actually consumes the semi-finished recipe's own raw materials. The custom
// field `has_producible_component` flags this; `action_bypass_subsequent` is the same method the
// "Bypass Subsequent" button calls (ticks Auto Produce on every eligible line). We call it first,
// whenever the flag is set, before action_confirm — exactly what a human would click by hand
// (2026-08-05 investigation, confirmed both methods are callable by the write account).
export async function confirmDoneMOs(date: string): Promise<MoConfirmResult> {
  const origin = `Lab ${date}`;
  const res: MoConfirmResult = { date, origin, eligible: 0, bypassed: [], confirmed: [], errors: [] };
  if (!odooWriteConfigured()) return res;

  const drafts = await odooExecute<any[]>('mrp.production', 'search_read',
    [[['origin', '=', origin], ['state', '=', 'draft']]],
    { fields: ['id', 'name', 'has_producible_component', 'auto_parent_production_id'] });
  res.eligible = drafts.length;

  for (const mo of drafts) {
    try {
      // Never touch an MO that is itself an auto-produced child of another MO in this same
      // batch — it gets confirmed as part of its parent's Auto Produce, not on its own.
      if (mo.auto_parent_production_id) continue;
      if (mo.has_producible_component) {
        await odooExecuteWrite('mrp.production', 'action_bypass_subsequent', [[mo.id]]);
        res.bypassed.push({ id: mo.id, name: mo.name });
      }
      await odooExecuteWrite('mrp.production', 'action_confirm', [[mo.id]]);
      res.confirmed.push({ id: mo.id, name: mo.name });
    } catch (e: any) {
      res.errors.push({ id: mo.id, name: mo.name, error: String(e?.message ?? e) });
    }
  }
  return res;
}

export interface MoProduceResult {
  date: string;
  origin: string;
  eligible: number;
  dryRun: boolean;
  produced: { id: number; name: string; qty: number; markDoneResult?: any }[];
  errors: { id: number; name: string; error: string }[];
}

// "Produce All" — fully validates the day's confirmed MOs, called right after confirmDoneMOs()
// in the same nightly cron (Axel, 2026-08-21: "je voudrais... si il est possible de produire
// completement la prod" — confirmed direct in the cron, no manual-review step first).
//
// Quantity: Axel confirmed the MO's own product_qty is already exactly "qty sent to stock" — set
// by syncStockToOdoo()/odoo-mo-sync.ts when the MO was created/updated during the day. There is
// no separate "how much was actually produced" figure to reconcile; validating for product_qty
// as-is is correct by construction, so this never needs to read lab_assignments.
//
// Mechanism (2026-08-21, round 3, after two failed rounds — see git history on this file for the
// full trail): the field that actually needs re-writing post-confirm is `product_qty` itself,
// NOT `qty_producing` as originally assumed. Axel confirmed this via Odoo's own dev-mode field
// inspector on the exact box he types into by hand (label "Quantity To Produce" / field
// product_qty) — that's what triggers Odoo's onchange cascade down onto every component move
// (quantities + move lines + "Consumed" ticked), the same cascade the earlier rounds tried to
// hand-roll via force-writing stock.move.quantity (wrong field, and once corrupted a real MO by
// cancelling its raw moves instead of consuming them) and manually creating stock.move.line
// records with picked=true (worked around the symptom but was unnecessary complexity). A plain
// write({product_qty: mo.product_qty}) — same numeric value, but the write itself is what
// matters — followed directly by button_mark_done, reaches state="done" cleanly: confirmed live
// on MO 38328 (fresh) and MO 38324 (previously stuck at "to_close" from earlier failed rounds,
// same fix recovered it too).
//
// Per-MO try/catch, same as confirmDoneMOs — an MO whose components are short on stock (or any
// other Odoo-side validation error) must not block the rest of the day's MOs from being produced.
// A failure here is NOT retried on a later day (same "never sweep other days" rule as
// confirmDoneMOs above) — it just stays 'confirmed'/'to_close' and shows up in lab_odoo_changes
// for an admin to handle by hand. If button_mark_done still returns an unresolved wizard action
// (e.g. mrp.consumption.warning) on some MO, that's treated as a hard error rather than guessed
// at — auto-resolving that wizard corrupted stock once already (MO 38321 incident) and should
// never be attempted blindly again; a recurrence needs a human to look at the actual MO in Odoo.
//
// opts.onlyMoId / opts.dryRun (2026-08-21, Axel: "essayer sur 1 ligne pour voir si tout
// fonctionne") — lets /api/odoo/confirm-mos test this in isolation on a single real MO (or just
// list what's eligible, writing nothing) before trusting it on the whole day's batch. onlyMoId
// drops the state filter entirely (matches by id alone) so a stuck 'to_close' test MO from a
// previous incomplete attempt can be targeted directly, not just fresh 'confirmed' ones.
export async function produceMOs(date: string, opts?: { onlyMoId?: number; dryRun?: boolean }): Promise<MoProduceResult> {
  const origin = `Lab ${date}`;
  const dryRun = !!opts?.dryRun;
  const res: MoProduceResult = { date, origin, eligible: 0, dryRun, produced: [], errors: [] };
  if (!odooWriteConfigured()) return res;

  const domain: any[] = opts?.onlyMoId
    ? [['id', '=', opts.onlyMoId]]
    : [['origin', '=', origin], ['state', '=', 'confirmed']];
  const mos = await odooExecute<any[]>('mrp.production', 'search_read',
    [domain], { fields: ['id', 'name', 'product_qty'] });
  res.eligible = mos.length;

  for (const mo of mos) {
    if (dryRun) { res.produced.push({ id: mo.id, name: mo.name, qty: mo.product_qty }); continue; }
    try {
      await odooExecuteWrite('mrp.production', 'write', [[mo.id], { product_qty: mo.product_qty }]);

      const markDoneResult = await odooExecuteWrite('mrp.production', 'button_mark_done', [[mo.id]]);
      if (markDoneResult && typeof markDoneResult === 'object' && markDoneResult.res_model) {
        throw new Error(`button_mark_done returned an unresolved wizard (${markDoneResult.res_model}) instead of validating — needs manual review in Odoo`);
      }
      res.produced.push({ id: mo.id, name: mo.name, qty: mo.product_qty, markDoneResult });
    } catch (e: any) {
      res.errors.push({ id: mo.id, name: mo.name, error: String(e?.message ?? e) });
    }
  }
  return res;
}
