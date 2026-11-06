import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';
import { roomsLinkedForDay, ROOMS, LAB_STOCK_ID } from '@/lib/rooms-odoo';

// OEM Orders (Axel, 2026-09-25) — the finished product (bag, or kg for cashews) is created in
// Odoo when the assistants record packaging, not when Hung bakes. One MO per packaging entry,
// origin "OEM <date>" so it never mixes with the "Lab <date>" MOs that odoo-mo-sync.ts /
// odoo-mo-confirm.ts manage (both are scoped strictly to origin "Lab <date>").
// Same sequence the nightly confirm-mos cron uses on the Lab MOs, run right away for this one MO:
//   create (with BoM) → action_bypass_subsequent if a component is itself producible (the
//   semi-finished bulk, which then auto-produces from raw materials) → action_confirm →
//   write product_qty (triggers the component cascade) → button_mark_done.
// Any wizard returned by button_mark_done is treated as an error, never auto-resolved.

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// Back-dating (Axel, 2026-11-06): production entered late must land on the day it was baked, in
// stock AND in accounting. Odoo stamps "now" on everything it closes, so for a past lab day:
//  - button_mark_done runs with context force_period_date → every valuation journal entry (the MO
//    and the sub-recipe MOs it closes in the same call) is dated on the production day;
//  - right after, the done stock moves / move lines of the MO and of its sub-recipe MOs (origin =
//    MO name, recursively) are re-dated to that day (12:00 VN), so stock-at-date is right.
// The MO record's own date_finished cannot be edited once done (Odoo refuses) — cosmetic only.
// The valuation layer keeps its creation date (not editable) — the journal entries carry the period.
export function labTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}
const isPastDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < labTodayIso();
const doneCtx = (date: string) => (isPastDay(date) ? { context: { force_period_date: date } } : {});

async function backdateMoTree(moId: number, moName: string, date: string): Promise<void> {
  if (!isPastDay(date)) return;
  const when = `${date} 05:00:00`;
  const ids = [moId]; let names = [moName];
  for (let depth = 0; depth < 4 && names.length; depth++) {
    const kids = await tmo(odooExecute<any[]>('mrp.production', 'search_read', [[['origin', 'in', names]]], { fields: ['id', 'name'], limit: 50 }), 15000, 'kids');
    const fresh = kids.filter(k => !ids.includes(k.id));
    ids.push(...fresh.map(k => k.id)); names = fresh.map(k => k.name);
  }
  const moves = await tmo(odooExecute<any[]>('stock.move', 'search_read',
    [['&', ['state', '=', 'done'], '|', ['production_id', 'in', ids], ['raw_material_production_id', 'in', ids]]], { fields: ['id'], limit: 500 }), 20000, 'moves');
  const moveIds = moves.map(m => m.id);
  if (!moveIds.length) return;
  await tmo(odooExecuteWrite('stock.move', 'write', [moveIds, { date: when }]), 30000, 'date-moves');
  const lines = await tmo(odooExecute<any[]>('stock.move.line', 'search_read', [[['move_id', 'in', moveIds]]], { fields: ['id'], limit: 2000 }), 20000, 'lines');
  if (lines.length) await tmo(odooExecuteWrite('stock.move.line', 'write', [lines.map(l => l.id), { date: when }]), 30000, 'date-lines');
}

export interface OemMoResult { ok: boolean; moId?: number; moName?: string; state?: string; error?: string }

export async function createAndProduceOemMO(sku: string, qty: number, date: string): Promise<OemMoResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  if (!(qty > 0)) return { ok: false, error: 'Quantity must be > 0' };
  let moId: number | undefined; let moName: string | undefined;
  try {
    const prods = await tmo(odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', '=', sku]]], { fields: ['id', 'uom_id', 'product_tmpl_id'], limit: 1 }), 20000, 'product');
    const p = prods[0];
    if (!p) return { ok: false, error: `SKU ${sku} not found in Odoo` };
    const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
    const boms = await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
      [['|', ['product_id', '=', p.id], ['product_tmpl_id', '=', tmplId]]], { fields: ['id', 'product_id'], limit: 10 }), 20000, 'bom');
    const bom = boms.find(b => b.product_id && (Array.isArray(b.product_id) ? b.product_id[0] : b.product_id) === p.id) ?? boms[0];
    if (!bom) return { ok: false, error: `No BoM for ${sku} in Odoo` };

    let dateField: string | null = null;
    try {
      const fg = await tmo(odooExecute<any>('mrp.production', 'fields_get', [['date_start', 'date_planned_start']], { attributes: ['type'] }), 15000, 'fg');
      dateField = fg?.date_start ? 'date_start' : (fg?.date_planned_start ? 'date_planned_start' : null);
    } catch { dateField = null; }

    moId = await tmo(odooExecuteWrite<number>('mrp.production', 'create', [{
      product_id: p.id, product_qty: qty, product_uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id,
      bom_id: bom.id, origin: `OEM ${date}`, ...(dateField ? { [dateField]: `${date} 02:00:00` } : {}),
      // OEM is made by Team Hung: once rooms are linked (2026-10-29) the bulk and its raw materials
      // come out of Room Hung, the bagged product goes to LAB/Stock.
      ...(roomsLinkedForDay(date) ? { picking_type_id: ROOMS.hung.manufType, location_src_id: ROOMS.hung.location, location_dest_id: LAB_STOCK_ID } : {}),
    }]), 25000, 'create');
    const [mo] = await tmo(odooExecute<any[]>('mrp.production', 'read', [[moId]], { fields: ['name', 'has_producible_component'] }), 15000, 'read');
    moName = mo?.name;
    if (mo?.has_producible_component) await tmo(odooExecuteWrite('mrp.production', 'action_bypass_subsequent', [[moId]]), 30000, 'bypass');
    await tmo(odooExecuteWrite('mrp.production', 'action_confirm', [[moId]]), 40000, 'confirm');
    await tmo(odooExecuteWrite('mrp.production', 'write', [[moId], { product_qty: qty }]), 30000, 'qty');
    const done = await tmo(odooExecuteWrite<any>('mrp.production', 'button_mark_done', [[moId]], doneCtx(date)), 60000, 'done');
    if (done && typeof done === 'object' && done.res_model) {
      return { ok: false, moId, moName, state: 'confirmed', error: `Odoo asked for confirmation (${done.res_model}) — finish ${moName} by hand in Odoo` };
    }
    try { await backdateMoTree(moId, moName ?? '', date); }
    catch (e: any) { return { ok: false, moId, moName, state: 'done', error: `done, but re-dating failed: ${String(e?.message ?? e)}` }; }
    // Room Hung: bags/cartons (not on any slip) are moved LAB/Stock → Room Hung by the rooms cron
    // (topUpRecentRoomMOs) — one place only, so the transfer is never made twice.
    return { ok: true, moId, moName, state: 'done' };
  } catch (e: any) {
    return { ok: false, moId, moName, error: String(e?.message ?? e) };
  }
}

// Retry an MO that was created but did not reach "done" (e.g. timeout, component issue):
// resume from its current state instead of creating a second MO for the same entry.
export async function resumeOemMO(moId: number, date?: string): Promise<OemMoResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  try {
    const [mo] = await tmo(odooExecute<any[]>('mrp.production', 'read', [[moId]], { fields: ['name', 'state', 'product_qty', 'has_producible_component'] }), 15000, 'read');
    if (!mo) return { ok: false, moId, error: 'MO not found in Odoo' };
    if (mo.state === 'done') return { ok: true, moId, moName: mo.name, state: 'done' };
    if (mo.state === 'cancel') return { ok: false, moId, moName: mo.name, state: 'cancel', error: `${mo.name} is cancelled in Odoo` };
    if (mo.state === 'draft') {
      if (mo.has_producible_component) await tmo(odooExecuteWrite('mrp.production', 'action_bypass_subsequent', [[moId]]), 30000, 'bypass');
      await tmo(odooExecuteWrite('mrp.production', 'action_confirm', [[moId]]), 40000, 'confirm');
    }
    await tmo(odooExecuteWrite('mrp.production', 'write', [[moId], { product_qty: mo.product_qty }]), 30000, 'qty');
    const done = await tmo(odooExecuteWrite<any>('mrp.production', 'button_mark_done', [[moId]], date ? doneCtx(date) : {}), 60000, 'done');
    if (done && typeof done === 'object' && done.res_model) {
      return { ok: false, moId, moName: mo.name, state: 'confirmed', error: `Odoo asked for confirmation (${done.res_model}) — finish ${mo.name} by hand in Odoo` };
    }
    if (date) await backdateMoTree(moId, mo.name, date);
    return { ok: true, moId, moName: mo.name, state: 'done' };
  } catch (e: any) {
    return { ok: false, moId, error: String(e?.message ?? e) };
  }
}
