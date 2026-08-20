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
// STILL PAUSED from the automatic path as of this revision — see /api/odoo/confirm-mos comment.
//
// Quantity: Axel confirmed the MO's own product_qty is already exactly "qty sent to stock" — set
// by syncStockToOdoo()/odoo-mo-sync.ts when the MO was created/updated during the day. There is
// no separate "how much was actually produced" figure to reconcile; validating for product_qty
// as-is is correct by construction, so this never needs to read lab_assignments.
//
// Mechanism (rewritten after a failed live test, 2026-08-21): setting qty_producing on the MO
// header alone is NOT enough — confirmed live that button_mark_done then leaves every raw-
// material move's actual `quantity` (the field that really matters, found via fields_get) at 0,
// landing the MO in "To Close" instead of "Done" and popping Odoo's own Consumption Warning
// dialog when a human then clicks Produce All by hand. Fix: explicitly write `quantity` on every
// move_raw_ids line to its `should_consume_qty` BEFORE calling button_mark_done — this is exactly
// what Odoo's "Set Quantities & Validate" wizard button does, done here via API instead of the
// interactive dialog. Axel confirmed this must happen unconditionally, ignoring on-hand/
// reservation state: several BOM components here are semi-finished "SM-*" products that
// deliberately run a large negative on-hand balance in this Odoo setup (never separately
// produced/replenished) — "faut pas que tu te bases sur on hand quantity, on doit pouvoir
// produire quand meme". Forcing quantity=should_consume_qty regardless of availability mirrors
// that intent.
//
// Per-MO try/catch, same as confirmDoneMOs — an MO whose components are short on stock (or any
// other Odoo-side validation error) must not block the rest of the day's MOs from being produced.
// A failure here is NOT retried on a later day (same "never sweep other days" rule as
// confirmDoneMOs above) — it just stays 'confirmed'/'to_close' and shows up in lab_odoo_changes
// for an admin to handle by hand.
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
    [domain], { fields: ['id', 'name', 'product_qty', 'move_raw_ids'] });
  res.eligible = mos.length;

  for (const mo of mos) {
    if (dryRun) { res.produced.push({ id: mo.id, name: mo.name, qty: mo.product_qty }); continue; }
    try {
      // 2026-08-21, round 3 — Axel confirmed via Odoo's own field inspector that the box he
      // actually types into (post-confirm, cascades every component correctly) is bound to
      // `product_qty`, not `qty_producing` as assumed. Writing the wrong field this whole time
      // is almost certainly why every earlier attempt needed manual workarounds. Testing this
      // alone, on a genuinely untouched MO, before deciding whether the move-line/picked
      // workaround below is even still needed.
      await odooExecuteWrite('mrp.production', 'write', [[mo.id], { product_qty: mo.product_qty }]);

      // 2026-08-21 — root cause confirmed via inspectMO on a genuinely untouched MO (38324,
      // WH/MO/38405): the mrp.consumption.warning wizard computes "consumed" from each raw
      // move's move_line_ids, and those stay completely EMPTY for a move that was never
      // reserved (state stuck at "confirmed" instead of "assigned" — happens for every
      // component with negative on-hand, which several semi-finished "SM-*" products here run
      // by design, per Axel). Writing to stock.move.quantity directly (the earlier, reverted
      // fix) never touches move_line_ids, so the wizard's own default still read 0 consumed no
      // matter what — and blindly accepting that default cancelled the raw moves instead of
      // consuming them (real stock corruption, caught on MO 38321). The actual fix: create the
      // missing stock.move.line ourselves, with quantity = should_consume_qty, mirroring what a
      // reservation would have produced had on-hand been positive — this is what the UI's
      // onchange does silently when a human types into the header Quantity field (Axel's manual
      // WH/MO/38403 test: components already showed "Consumed" ticked before he even clicked
      // Produce All). Only touches moves that have zero move_line_ids — a move that already got
      // reserved normally (positive on-hand) is left alone.
      // 2026-08-21, round 2: creating the move line alone still wasn't enough — a re-test on
      // MO 38324 (move lines from the previous attempt, quantity already correctly matching
      // should_consume_qty) still popped the exact same wizard with product_consumed_qty_uom: 0
      // for every line. stock.move.line has a separate `picked` boolean (Odoo 17+) — the actual
      // "this was physically picked/counted" flag, distinct from quantity — and our create()
      // call never set it, so it defaulted to false. That's almost certainly what the wizard
      // actually reads as "consumed". Setting it explicitly now, both on newly-created lines and
      // on any pre-existing ones from earlier test attempts that are missing it.
      const moveIds: number[] = mo.move_raw_ids ?? [];
      if (moveIds.length) {
        const moves = await odooExecute<any[]>('stock.move', 'search_read', [[['id', 'in', moveIds]]],
          { fields: ['id', 'product_id', 'product_uom', 'location_id', 'location_dest_id', 'move_line_ids', 'should_consume_qty'] });
        for (const mv of moves) {
          if ((mv.move_line_ids ?? []).length) {
            // Pre-existing line (e.g. from an earlier test attempt on this same MO) — make sure
            // it's marked picked, don't touch its quantity (already correct or reserved normally).
            await odooExecuteWrite('stock.move.line', 'write', [mv.move_line_ids, { picked: true }]);
            continue;
          }
          await odooExecuteWrite('stock.move.line', 'create', [{
            move_id: mv.id,
            product_id: mv.product_id[0],
            product_uom_id: mv.product_uom[0],
            quantity: mv.should_consume_qty,
            location_id: mv.location_id[0],
            location_dest_id: mv.location_dest_id[0],
            picked: true,
          }]);
        }
      }

      // button_mark_done returns `true` when it fully validates, or an ir.actions.act_window
      // dict (the mrp.consumption.warning wizard) when it wants a follow-up confirmation
      // instead — an API write call doesn't raise for that, so a naive caller sees "no
      // exception" and wrongly assumes success. Do NOT auto-resolve that wizard: the one time
      // this was tried (2026-08-21, MO 38321/WH-MO-38402, back when the block above was still
      // force-writing stock.move.quantity) it silently CANCELLED every raw-material move
      // (quantity reset to 0, on-hand pushed back up) instead of consuming them — the MO
      // reached "done" but its components were never actually deducted from stock, a real
      // inventory corruption, not just a cosmetic stuck status. A wizard appearing here now
      // (after dropping the force-write above) means this MO's consumption genuinely doesn't
      // match its BOM for some other reason — treat that as a failure to review by hand, same
      // as any other Odoo-side validation error, rather than guessing at a resolution again.
      const markDoneResult = await odooExecuteWrite('mrp.production', 'button_mark_done', [[mo.id]]);
      if (markDoneResult && typeof markDoneResult === 'object' && markDoneResult.res_model) {
        // Diagnostic (2026-08-21, round 2): the wizard still popped even after creating
        // move_line_ids with quantity exactly equal to should_consume_qty — surfacing the full
        // payload (not just res_model) since a plain quantity mismatch shouldn't be the cause
        // anymore. Might be the negative-stock "consumption": "warning" classification itself,
        // independent of whether the quantity matches.
        throw new Error(`button_mark_done returned an unresolved wizard, full payload: ${JSON.stringify(markDoneResult)}`);
      }
      res.produced.push({ id: mo.id, name: mo.name, qty: mo.product_qty, markDoneResult });
    } catch (e: any) {
      res.errors.push({ id: mo.id, name: mo.name, error: String(e?.message ?? e) });
    }
  }
  return res;
}
