import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// Bring the Odoo production of one product for one lab-day DOWN to `target` units (Axel,
// 2026-10-24 — "Bếp chưa làm cái này" at delivery check). Odoo MOs for the day carry origin
// "Lab <day>" and total what was sent to stock (odoo-mo-sync.ts). Order of operations:
//   1. a draft MO is lowered (or cancelled when it drops to 0);
//   2. what is still too much on DONE MOs is unbuilt (mrp.unbuild + action_unbuild), newest
//      MO first — the same sequence used by hand for BEBM (UB/00032) and BCP (UB/00034).
// MOs that are confirmed but not done are never touched: reported back as an error so a human
// decides. Never deletes anything.
export async function reduceDayProduction(day: string, sku: string, target: number, note: string, typeId?: number | null):
  Promise<{ ok: boolean; refs: string[]; error?: string }> {
  const refs: string[] = [];
  if (!odooWriteConfigured()) return { ok: false, refs, error: 'Odoo write account not configured' };
  try {
    const prods = await tmo(odooExecute<any[]>('product.product', 'search_read', [[['default_code', '=', sku]]], { fields: ['id', 'uom_id'], limit: 1 }), 15000, 'prod');
    if (!prods.length) return { ok: false, refs, error: `Product ${sku} not found in Odoo` };
    const p = prods[0];
    const mos = await tmo(odooExecute<any[]>('mrp.production', 'search_read',
      [[['origin', '=', `Lab ${day}`], ['product_id', '=', p.id], ['state', '!=', 'cancel'], ...(typeId ? [['picking_type_id', '=', typeId]] : [])]],
      { fields: ['id', 'name', 'state', 'product_qty', 'qty_produced', 'bom_id', 'location_dest_id', 'location_src_id', 'product_uom_id'], order: 'id desc' }), 20000, 'mos');
    // Done unbuilds do not lower the MO's quantity: subtract them (else a second correction unbuilds again).
    const unbuilt: Record<number, number> = {};
    if (mos.length) {
      const ubs = await tmo(odooExecuteWrite<any[]>('mrp.unbuild', 'search_read', [[['mo_id', 'in', mos.map((m: any) => m.id)], ['state', '=', 'done']]], { fields: ['mo_id', 'product_qty'] }), 15000, 'unbuilds');
      for (const u of ubs) if (u.mo_id) { const mid = Array.isArray(u.mo_id) ? u.mo_id[0] : u.mo_id; unbuilt[mid] = (unbuilt[mid] ?? 0) + Number(u.product_qty || 0); }
    }
    const qtyOf = (m: any) => m.state === 'done' ? Number(m.qty_produced || m.product_qty) - (unbuilt[m.id] ?? 0) : Number(m.product_qty);
    let total = mos.reduce((s, m) => s + qtyOf(m), 0);
    let excess = total - target;
    if (excess <= 0) return { ok: true, refs };

    for (const m of mos.filter(x => x.state === 'draft')) {
      if (excess <= 0) break;
      const q = Number(m.product_qty);
      if (q > excess) {
        await tmo(odooExecuteWrite('mrp.production', 'write', [[m.id], { product_qty: q - excess }]), 20000, 'lower draft');
        refs.push(`${m.name} ${q}→${q - excess}`); excess = 0;
      } else {
        await tmo(odooExecuteWrite('mrp.production', 'action_cancel', [[m.id]]), 20000, 'cancel draft');
        refs.push(`${m.name} cancelled`); excess -= q;
      }
    }
    for (const m of mos.filter(x => x.state === 'done')) {
      if (excess <= 0) break;
      const q = Math.min(excess, qtyOf(m));
      if (q <= 0) continue;
      // Finished product taken back from where the MO put it; components returned where the MO took
      // them (the team's room once rooms are linked, 2026-10-29 — LAB/Stock before, same as `loc`).
      const loc = Array.isArray(m.location_dest_id) ? m.location_dest_id[0] : m.location_dest_id;
      const back = (Array.isArray(m.location_src_id) ? m.location_src_id[0] : m.location_src_id) || loc;
      const vals: any = {
        mo_id: m.id, product_id: p.id, product_qty: q, location_id: loc, location_dest_id: back,
        product_uom_id: Array.isArray(m.product_uom_id) ? m.product_uom_id[0] : (Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id),
      };
      if (m.bom_id) vals.bom_id = Array.isArray(m.bom_id) ? m.bom_id[0] : m.bom_id;
      const ubId = await tmo(odooExecuteWrite<number>('mrp.unbuild', 'create', [vals]), 20000, 'unbuild create');
      await tmo(odooExecuteWrite('mrp.unbuild', 'action_unbuild', [[ubId]]), 30000, 'unbuild');
      const [ub] = await tmo(odooExecuteWrite<any[]>('mrp.unbuild', 'read', [[ubId]], { fields: ['name', 'state'] }), 15000, 'unbuild read');
      if (ub?.state !== 'done') return { ok: false, refs, error: `Unbuild ${ub?.name ?? ubId} not done (state ${ub?.state})` };
      refs.push(`${ub.name} −${q} (${m.name})`);
      try {
        await odooExecuteWrite('mrp.production', 'message_post', [[m.id]], {
          body: `Lab app — ${q} défait (${ub.name}) : ${note}`, message_type: 'comment', subtype_xmlid: 'mail.mt_note',
        });
      } catch { /* note is best-effort */ }
      excess -= q;
    }
    if (excess > 0) return { ok: false, refs, error: `${excess} still too much on confirmed (not done) MOs — fix by hand` };
    return { ok: true, refs };
  } catch (e: any) {
    return { ok: false, refs, error: String(e?.message ?? e) };
  }
}

/**
 * Rooms linked (2026-10-29): MOs are per product AND team, so a correction must lower the MOs of the
 * team whose transfers were lowered — never another team's. Targets come from what each team still
 * has "sent to stock" that day. Before the start day, or if a legacy (type 11) MO exists that day,
 * behaves exactly as before (one target for the product).
 */
export async function reduceDayProductionAll(sb: any, day: string, sku: string, note: string):
  Promise<{ ok: boolean; refs: string[]; error?: string }> {
  const { sentToStockBySku } = await import('@/lib/odoo-mo-sync');
  const { roomsLinkedForDay, roomOf, ROOMS, LAB_MANUF_TYPE_ID } = await import('@/lib/rooms-odoo');
  const sent = await sentToStockBySku(sb, day);
  if (!roomsLinkedForDay(day)) return reduceDayProduction(day, sku, sent.bySku[sku] ?? 0, note);
  const prods = await odooExecute<any[]>('product.product', 'search_read', [[['default_code', '=', sku]]], { fields: ['id'], limit: 1 });
  if (!prods.length) return { ok: false, refs: [], error: `Product ${sku} not found in Odoo` };
  const legacy = await odooExecute<any[]>('mrp.production', 'search_read',
    [[['origin', '=', `Lab ${day}`], ['product_id', '=', prods[0].id], ['state', '!=', 'cancel'], ['picking_type_id', '=', LAB_MANUF_TYPE_ID]]], { fields: ['id'], limit: 1 });
  if (legacy.length) return reduceDayProduction(day, sku, sent.bySku[sku] ?? 0, note);
  const byType: Record<number, number> = {};
  for (const r of Object.values(ROOMS)) byType[r.manufType] = 0;
  for (const [team, m] of Object.entries(sent.byTeamSku)) {
    const t = roomOf(team)?.manufType; if (!t) continue;
    byType[t] += m[sku] ?? 0;
  }
  const refs: string[] = []; const errs: string[] = [];
  for (const [typeId, target] of Object.entries(byType)) {
    const r = await reduceDayProduction(day, sku, target, note, Number(typeId));
    refs.push(...r.refs); if (!r.ok && r.error) errs.push(r.error);
  }
  return { ok: !errs.length, refs, ...(errs.length ? { error: errs.join(' · ') } : {}) };
}
