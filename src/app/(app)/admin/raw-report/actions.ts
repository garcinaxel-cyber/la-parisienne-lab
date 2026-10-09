'use server';
// Raw materials taken vs recipes (Axel, 2026-10-08) — admin only (costs inside).
//   Taken   = the chefs' storage withdrawals recorded in the app (storage correction wins).
//   Recipes = production declared in the app (lab_daily_stats.qty_produced, + OEM packing for Hưng)
//             × the Odoo BOMs, exploded down to raw materials (same recipes Odoo uses for its MOs).
// Read only on Odoo. Test phase: only team Hưng records withdrawals.
import { rawService, rawActor } from '@/lib/raw-materials-db';
import { resolveRawMaterialsBatch } from '@/lib/mp-consumption';
import { isOemSku } from '@/lib/oem';
import { labDayUtcRange, odooExecute } from '@/lib/odoo';


export type ReportRow = {
  code: string; name: string; uom: string; cost: number;
  taken: Record<string, number>; recipe: Record<string, number>;
  slips: Record<string, number>;
};
export type RawReport = { rows: ReportRow[]; unresolved: { sku: string; name: string; qty: number }[]; teamsWithSlips: string[] };

const normUom = (u: string) => u.toLowerCase().replace(/\(s\)$/, '').trim();
function toUnit(qty: number, from: string, to: string): number {
  const f = normUom(from), t = normUom(to);
  if (f === t) return qty;
  if ((f === 'g' || f === 'gram') && t === 'kg') return qty / 1000;
  if (f === 'kg' && (t === 'g' || t === 'gram')) return qty * 1000;
  if (f === 'ml' && t === 'l') return qty / 1000;
  if (f === 'l' && t === 'ml') return qty * 1000;
  return qty;
}

export async function getRawReportAction(from: string, to: string): Promise<{ data?: RawReport; error?: string }> {
  const a = await rawActor();
  if (!a || a.role !== 'admin') return { error: 'Admin only' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return { error: 'Bad period' };
  const start = labDayUtcRange(from).start, end = labDayUtcRange(to).end;
  const rows = new Map<string, ReportRow>();
  const row = (code: string, name: string, uom: string) => {
    let r = rows.get(code);
    if (!r) { r = { code, name, uom, cost: 0, taken: {}, recipe: {}, slips: {} }; rows.set(code, r); }
    return r;
  };

  // 1) Taken
  const { data: ws } = await db.from('lab_raw_withdrawals').select('id, team').gte('created_at', start).lt('created_at', end).limit(5000);
  const teamOf = new Map((ws ?? []).map(w => [w.id, w.team]));
  const teamsWithSlips = Array.from(new Set((ws ?? []).map(w => w.team)));
  const wIds = Array.from(teamOf.keys());
  for (let i = 0; i < wIds.length; i += 200) {
    const { data: ls } = await db.from('lab_raw_withdrawal_lines').select('withdrawal_id, sku, name, uom, qty, corrected_qty').in('withdrawal_id', wIds.slice(i, i + 200));
    for (const l of ls ?? []) {
      if (!l.sku) continue;
      const team = teamOf.get(l.withdrawal_id) ?? '?';
      const r = row(l.sku, l.name, l.uom);
      r.taken[team] = (r.taken[team] ?? 0) + Number(l.corrected_qty ?? l.qty);
      r.slips[team] = (r.slips[team] ?? 0) + 1;
    }
  }

  // 2) Production declared in the app (OEM SKUs come from the OEM packing log instead)
  type Prod = { sku: string; team: string; name: string; qty: number };
  const prod = new Map<string, Prod>();
  const addProd = (sku: string, team: string, name: string, qty: number) => {
    if (!sku || !(qty > 0)) return;
    const k = `${sku}::${team}`; const p = prod.get(k) ?? { sku, team, name, qty: 0 }; p.qty += qty; prod.set(k, p);
  };
  for (let off = 0; ; off += 1000) {
    const { data: st } = await db.from('lab_daily_stats').select('sku, product_name, team, qty_produced').gte('day', from).lte('day', to).gt('qty_produced', 0).range(off, off + 999);
    for (const s of st ?? []) if (!isOemSku(s.sku)) addProd(s.sku, s.team, s.product_name || s.sku, Number(s.qty_produced));
    if (!st || st.length < 1000) break;
  }
  const { data: packed } = await db.from('lab_mm_packaging_log').select('sku, qty').eq('kind', 'packed').gte('pack_date', from).lte('pack_date', to).limit(5000);
  for (const p of packed ?? []) addProd(p.sku, 'hung', p.sku, Number(p.qty));

  const prods = Array.from(prod.values());
  const unresolved: RawReport['unresolved'] = [];
  if (prods.length) {
    let bySku: Map<string, any[] | null>;
    try { ({ bySku } = await resolveRawMaterialsBatch(Array.from(new Set(prods.map(p => p.sku))))); }
    catch (e: any) { return { error: `Odoo: ${e?.message ?? e}` }; }
    for (const p of prods) {
      const lines = bySku.get(p.sku);
      if (!lines || !lines.length) { unresolved.push({ sku: p.sku, name: p.name, qty: p.qty }); continue; }
      for (const l of lines) {
        const r = row(l.code, l.name, rows.get(l.code)?.uom ?? l.uom);
        r.recipe[p.team] = (r.recipe[p.team] ?? 0) + toUnit(l.qtyPerUnit * p.qty, l.uom, r.uom);
      }
    }
  }

  // 3) Odoo unit cost + product unit (read only)
  const codes = Array.from(rows.keys());
  try {
    for (let i = 0; i < codes.length; i += 200) {
      const ps = await odooExecute<any[]>('product.product', 'search_read', [[['default_code', 'in', codes.slice(i, i + 200)]]],
        { fields: ['default_code', 'name', 'standard_price', 'uom_id'], context: { active_test: false }, limit: 500 });
      for (const p of ps ?? []) {
        const r = rows.get(p.default_code); if (!r) continue;
        r.cost = Number(p.standard_price) || 0;
        const u = Array.isArray(p.uom_id) ? String(p.uom_id[1]) : r.uom;
        if (normUom(u) !== normUom(r.uom)) { // align every quantity on the Odoo product unit
          for (const t of Object.keys(r.recipe)) r.recipe[t] = toUnit(r.recipe[t], r.uom, u);
          for (const t of Object.keys(r.taken)) r.taken[t] = toUnit(r.taken[t], r.uom, u);
          r.uom = u;
        }
        if (!r.name) r.name = p.name;
      }
    }
  } catch { /* costs are best-effort: quantities still show */ }

  return { data: { rows: Array.from(rows.values()), unresolved: unresolved.sort((x, y) => y.qty - x.qty).slice(0, 40), teamsWithSlips } };
}


// Off-recipe withdrawals still to regularise (Axel, 2026-10-09): lines flagged when recorded, whose
// raw material is still in no Odoo recipe and not marked "no recipe needed". Last 30 days.
export type OffRecipeLine = { id: string; day: string; team: string; takenBy: string | null; name: string; nameVi: string | null; qty: number; uom: string; usedFor: string | null };
export async function getOffRecipeLinesAction(days = 30): Promise<{ items?: OffRecipeLine[]; regularised?: number; error?: string }> {
  const a = await rawActor();
  if (!a || a.role !== 'admin') return { error: 'Admin only' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 120) * 86400000).toISOString();
  const { data: ws } = await db.from('lab_raw_withdrawals').select('id, team, taken_by, created_at').gte('created_at', since).limit(3000);
  const byW = new Map((ws ?? []).map((w: any) => [w.id, w]));
  const ids = Array.from(byW.keys());
  const lines: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('lab_raw_withdrawal_lines').select('id, withdrawal_id, tmpl_id, name, uom, qty, corrected_qty, used_for')
      .in('withdrawal_id', ids.slice(i, i + 200)).eq('off_recipe', true);
    lines.push(...(data ?? []));
  }
  const tmplIds = Array.from(new Set(lines.map(l => l.tmpl_id).filter(Boolean)));
  const { data: mats } = tmplIds.length ? await db.from('lab_raw_materials').select('tmpl_id, name_vi, bom_count, no_recipe_needed').in('tmpl_id', tmplIds) : { data: [] as any[] };
  const mat = new Map((mats ?? []).map((m: any) => [m.tmpl_id, m]));
  let regularised = 0;
  const items: OffRecipeLine[] = [];
  for (const l of lines) {
    const m: any = mat.get(l.tmpl_id);
    if (m && (Number(m.bom_count) > 0 || m.no_recipe_needed)) { regularised++; continue; }
    const w: any = byW.get(l.withdrawal_id);
    items.push({ id: l.id, day: String(w?.created_at ?? ''), team: w?.team ?? '', takenBy: w?.taken_by ?? null, name: l.name, nameVi: m?.name_vi ?? null,
      qty: Number(l.corrected_qty ?? l.qty), uom: l.uom, usedFor: l.used_for ?? null });
  }
  items.sort((x, y) => y.day.localeCompare(x.day));
  return { items, regularised };
}
