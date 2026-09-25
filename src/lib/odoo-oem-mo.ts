import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

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
    }]), 25000, 'create');
    const [mo] = await tmo(odooExecute<any[]>('mrp.production', 'read', [[moId]], { fields: ['name', 'has_producible_component'] }), 15000, 'read');
    moName = mo?.name;
    if (mo?.has_producible_component) await tmo(odooExecuteWrite('mrp.production', 'action_bypass_subsequent', [[moId]]), 30000, 'bypass');
    await tmo(odooExecuteWrite('mrp.production', 'action_confirm', [[moId]]), 40000, 'confirm');
    await tmo(odooExecuteWrite('mrp.production', 'write', [[moId], { product_qty: qty }]), 30000, 'qty');
    const done = await tmo(odooExecuteWrite<any>('mrp.production', 'button_mark_done', [[moId]]), 60000, 'done');
    if (done && typeof done === 'object' && done.res_model) {
      return { ok: false, moId, moName, state: 'confirmed', error: `Odoo asked for confirmation (${done.res_model}) — finish ${moName} by hand in Odoo` };
    }
    return { ok: true, moId, moName, state: 'done' };
  } catch (e: any) {
    return { ok: false, moId, moName, error: String(e?.message ?? e) };
  }
}

// Retry an MO that was created but did not reach "done" (e.g. timeout, component issue):
// resume from its current state instead of creating a second MO for the same entry.
export async function resumeOemMO(moId: number): Promise<OemMoResult> {
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
    const done = await tmo(odooExecuteWrite<any>('mrp.production', 'button_mark_done', [[moId]]), 60000, 'done');
    if (done && typeof done === 'object' && done.res_model) {
      return { ok: false, moId, moName: mo.name, state: 'confirmed', error: `Odoo asked for confirmation (${done.res_model}) — finish ${mo.name} by hand in Odoo` };
    }
    return { ok: true, moId, moName: mo.name, state: 'done' };
  } catch (e: any) {
    return { ok: false, moId, error: String(e?.message ?? e) };
  }
}
