// Server-only: the Odoo side of the Lab raw-material / packaging inventory (Axel, 2026-11-09).
// Odoo is called three times in a count's life, never while the team counts:
//   1. scopeAtLab   — when the count is opened: which products have stock or recent moves at LAB/Stock.
//   2. theoreticals — on the recap: the stock of each product at ITS count time (a count spread
//                     over two days stays right), with the October rule: a vendor receipt validated
//                     late but scheduled before the count belongs before the count.
//   3. createDraftSheet — on send: ONE stock.inventory at LAB/Stock in progress, lines written with
//                     counted quantities only (Odoo computes the system quantity), never applied.
import { odooExecuteWrite, odooWriteConfigured } from './odoo';
import { getLabStockLocationId, addMissingCountLines } from './odoo-inventory';

const NO_MAIL = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true };
const odooDt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const id0 = (v: any): number => (Array.isArray(v) ? v[0] : v);
function chunks<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

/** Products (product.product ids) with stock ≠ 0 at LAB/Stock, or a done move there in the last `days` days. */
export async function scopeAtLab(productIds: number[], days = 90): Promise<Set<number>> {
  const out = new Set<number>();
  if (!productIds.length) return out;
  const loc = await getLabStockLocationId();
  for (const c of chunks(productIds, 400)) {
    const qs = await odooExecuteWrite<any[]>('stock.quant', 'search_read',
      [[['product_id', 'in', c], ['location_id', '=', loc], ['quantity', '!=', 0]]], { fields: ['product_id'], limit: 5000 });
    for (const q of qs) out.add(id0(q.product_id));
    const since = odooDt(new Date(Date.now() - days * 86400000));
    const dom = [['product_id', 'in', c], ['state', '=', 'done'], ['date', '>=', since], '|', ['location_id', '=', loc], ['location_dest_id', '=', loc]];
    try {
      const groups = await odooExecuteWrite<any[]>('stock.move.line', 'read_group', [dom, ['product_id'], ['product_id']], { lazy: false });
      for (const g of groups) if (g.product_id) out.add(id0(g.product_id));
    } catch {
      for (let offset = 0; ; offset += 5000) {
        const mls = await odooExecuteWrite<any[]>('stock.move.line', 'search_read', [dom], { fields: ['product_id'], limit: 5000, offset });
        for (const m of mls) out.add(id0(m.product_id));
        if (mls.length < 5000) break;
      }
    }
  }
  return out;
}

/** Stock of each product at LAB/Stock at its own count time. */
export async function theoreticals(lines: { productId: number; countedAt: Date }[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  if (!lines.length) return out;
  const loc = await getLabStockLocationId();
  const at: Record<number, number> = {};
  for (const l of lines) { at[l.productId] = l.countedAt.getTime(); out[l.productId] = 0; }
  const pids = Object.keys(at).map(Number);
  const minAt = new Date(Math.min(...Object.values(at)));
  for (const c of chunks(pids, 400)) {
    const qs = await odooExecuteWrite<any[]>('stock.quant', 'search_read',
      [[['product_id', 'in', c], ['location_id', '=', loc]]], { fields: ['product_id', 'quantity'], limit: 5000 });
    for (const q of qs) out[id0(q.product_id)] += Number(q.quantity ?? 0);
    for (let offset = 0; ; offset += 2000) {
      const mls = await odooExecuteWrite<any[]>('stock.move.line', 'search_read',
        [[['product_id', 'in', c], ['state', '=', 'done'], ['date', '>', odooDt(minAt)], '|', ['location_id', '=', loc], ['location_dest_id', '=', loc]]],
        { fields: ['product_id', 'quantity_product_uom', 'location_id', 'location_dest_id', 'date', 'picking_code', 'scheduled_date'], limit: 2000, offset, order: 'id asc' });
      for (const ml of mls) {
        const pid = id0(ml.product_id);
        const t = Date.parse(String(ml.date).replace(' ', 'T') + 'Z');
        if (!(t > at[pid])) continue;
        // receipt validated late but scheduled before the count: it was physically there (October rule)
        if (ml.picking_code === 'incoming' && ml.scheduled_date && Date.parse(String(ml.scheduled_date).replace(' ', 'T') + 'Z') <= at[pid]) continue;
        const from = id0(ml.location_id), to = id0(ml.location_dest_id);
        const q = Number(ml.quantity_product_uom ?? 0);
        if (to === loc && from !== loc) out[pid] -= q;
        if (from === loc && to !== loc) out[pid] += q;
      }
      if (mls.length < 2000) break;
    }
  }
  for (const k of Object.keys(out)) out[+k] = Math.round(out[+k] * 100000) / 100000;
  return out;
}

/** One draft (in progress, not applied) count sheet at LAB/Stock with the given lines. */
export async function createDraftSheet(args: { name: string; countDate: string; firstCountAt: Date; lines: { productId: number; theoretical: number; counted: number }[] })
  : Promise<{ ok: true; inventoryId: number; lineIds: Record<number, number> } | { ok: false; error: string }> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  const loc = await getLabStockLocationId();
  const pids = args.lines.map(l => l.productId);
  // the same product must not sit in another open count at LAB (Odoo refuses, and it would apply twice)
  const busy = await odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'search_read',
    [[['product_id', 'in', pids], ['location_id', '=', loc], ['inventory_id.state', '=', 'in_progress']]], { fields: ['product_id', 'inventory_id'], limit: 50 });
  if (busy.length) {
    const sheets = Array.from(new Set(busy.map(b => b.inventory_id?.[1] ?? b.inventory_id?.[0]))).join(', ');
    return { ok: false, error: `${busy.length} produit(s) déjà dans une feuille Odoo ouverte (${sheets}). Ferme-la avant d'envoyer.` };
  }
  let invId: number;
  try {
    invId = await odooExecuteWrite<number>('stock.inventory', 'create', [{
      name: args.name, product_selection: 'manual', product_ids: [[6, 0, pids]], location_ids: [[6, 0, [loc]]],
      date: odooDt(args.firstCountAt), accounting_date: args.countDate,
    }], { context: NO_MAIL });
    await odooExecuteWrite('stock.inventory', 'action_state_to_in_progress', [[invId]], { context: NO_MAIL });
  } catch (e: any) {
    return { ok: false, error: `Odoo: ${String(e?.message ?? e).slice(0, 300)}` };
  }
  const readLines = async () => {
    const [inv] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['count_line_ids'] });
    const ids: number[] = inv?.count_line_ids ?? [];
    const rows = ids.length ? await odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'read', [ids], { fields: ['product_id'] }) : [];
    const m: Record<number, number> = {};
    for (const r of rows) m[id0(r.product_id)] = r.id;
    return m;
  };
  let lineIds = await readLines();
  const missing = pids.filter(p => !lineIds[p]);
  if (missing.length) { await addMissingCountLines(invId, loc, missing); lineIds = await readLines(); }
  // Counted quantities only: the "System Quantity at Cut-off" is read-only in Odoo and computed by
  // the module on Begin Adjustments (Liêm, 2026-11-10: the app only writes what a user can type).
  const cmds = args.lines.filter(l => lineIds[l.productId]).map(l =>
    [1, lineIds[l.productId], { counted_qty: l.counted, counted_set: true }]);
  for (const c of chunks(cmds, 150)) await odooExecuteWrite('stock.inventory', 'write', [[invId], { count_line_ids: c }], { context: NO_MAIL });
  try {
    await odooExecuteWrite('stock.inventory', 'message_post', [[invId]], {
      body: `<p>Lab app — kiểm kê ${args.lines.length} dòng, chỉ nhập số đếm (tồn sổ do Odoo tính). Chưa áp dụng: kiểm tra rồi Apply.</p><p>Lab app — ${args.lines.length} lines, counted quantities only (system quantity computed by Odoo). Not applied: check, then apply.</p>`,
      message_type: 'comment', subtype_id: 2,
    });
  } catch { /* note is best-effort */ }
  return { ok: true, inventoryId: invId, lineIds };
}

/** Unit cost (standard_price) of each product, for the gap values on the recap. */
export async function productCosts(productIds: number[]): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  for (const c of chunks(Array.from(new Set(productIds)), 400)) {
    const rows = await odooExecuteWrite<any[]>('product.product', 'read', [c], { fields: ['standard_price'] });
    for (const r of rows) m.set(r.id, Number(r.standard_price ?? 0));
  }
  return m;
}
