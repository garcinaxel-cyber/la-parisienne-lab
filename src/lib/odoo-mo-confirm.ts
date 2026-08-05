import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

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
