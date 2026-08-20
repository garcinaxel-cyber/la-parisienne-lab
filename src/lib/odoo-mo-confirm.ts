import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

// Read-only diagnostic (2026-08-21) — see route comment. Introspects stock.move's actual field
// names (fields_get) plus the move_raw_ids values for one MO, so the real "how much was
// consumed" field can be identified and force-set before button_mark_done, instead of guessing.
export interface MoInspectResult {
  mo: { id: number; name: string; state: string; product_qty: number; qty_producing: number; move_raw_ids: number[]; move_finished_ids: number[] } | null;
  moveFields: string[];
  moves: any[];
  finishedMoves: any[];
  error?: string;
}

export async function inspectMO(moId: number): Promise<MoInspectResult> {
  const res: MoInspectResult = { mo: null, moveFields: [], moves: [], finishedMoves: [] };
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

    const selectFields = Array.from(new Set(['id', 'product_id', 'state', 'product_uom_qty', ...candidateFields]));
    if (moveIds.length) {
      res.moves = await odooExecute<any[]>('stock.move', 'search_read', [[['id', 'in', moveIds]]], { fields: selectFields });
    }
    if (finishedIds.length) {
      res.finishedMoves = await odooExecute<any[]>('stock.move', 'search_read', [[['id', 'in', finishedIds]]], { fields: selectFields });
    }
  } catch (e: any) {
    res.error = String(e?.message ?? e);
  }
  return res;
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
  produced: { id: number; name: string; qty: number }[];
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
      await odooExecuteWrite('mrp.production', 'write', [[mo.id], { qty_producing: mo.product_qty }]);

      // Force every component's actual consumption to its full demand, regardless of on-hand
      // availability (see function comment above — semi-finished components here intentionally
      // run negative on-hand and must not block production). Mirrors "Set Quantities & Validate".
      const moveIds: number[] = mo.move_raw_ids ?? [];
      if (moveIds.length) {
        const moves = await odooExecute<any[]>('stock.move', 'search_read',
          [[['id', 'in', moveIds]]], { fields: ['id', 'should_consume_qty'] });
        for (const mv of moves) {
          await odooExecuteWrite('stock.move', 'write', [[mv.id], { quantity: mv.should_consume_qty }]);
        }
      }

      await odooExecuteWrite('mrp.production', 'button_mark_done', [[mo.id]]);
      res.produced.push({ id: mo.id, name: mo.name, qty: mo.product_qty });
    } catch (e: any) {
      res.errors.push({ id: mo.id, name: mo.name, error: String(e?.message ?? e) });
    }
  }
  return res;
}
