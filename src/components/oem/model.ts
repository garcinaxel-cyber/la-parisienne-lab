// Shared types + derived figures for the OEM Orders tracker (see OemOrdersView.tsx).

export type Item = {
  sku: string; product_name: string; group_key: string; group_name: string;
  unit: 'bag' | 'kg'; unit_weight_g: number; qty_ordered: number; sort_order: number;
  is_active: boolean; client_name: string | null; updated_at: string | null; updated_by_name: string | null;
};
export type ProdLog = {
  id: string; prod_date: string; group_key: string; sku: string | null; weight_kg: number;
  note: string | null; created_at: string; created_by_name: string | null;
  // reception (v2): only received kg become packable bulk and count as Hung's progress
  status: 'pending' | 'received'; received_kg: number | null; received_at: string | null;
  received_by_name: string | null; receive_note: string | null;
};
export type PackLog = {
  id: string; pack_date: string; kind: 'packed' | 'scrap_bulk' | 'scrap_finished' | 'found'; source: 'entry' | 'inventory'; sku: string; group_key: string;
  qty: number; bags_count: number | null; note: string | null; odoo_mo_id: number | null; odoo_status: string | null;
  odoo_error: string | null; odoo_ref: string | null; created_at: string; created_by: string | null; created_by_name: string | null;
  updated_at: string | null; updated_by_name: string | null;
};
export type Hist = { id: string; sku: string; qty_before: number; qty_after: number; changed_at: string; changed_by_name: string | null };
export type Delivery = {
  order_ref: string; delivery_date: string; customer: string | null; sku: string;
  qty_planned: number | null; qty_expected: number | null; qty_checked: number | null; line_status: string | null;
  order_status: string | null; validated_at: string | null; validated_by_name: string | null;
  not_delivered: boolean; odoo_push_status: string | null; odoo_validated_at: string | null;
};
export type FgCount = { id: string; count_date: string; sku: string; qty_counted: number; qty_theoretical: number | null; gap: number | null; status: 'applied' | 'pending_admin' | 'rejected'; created_at: string; created_by_name: string | null; decided_by_name: string | null };
export type Ingredient = { code: string; name: string; unit: string; sort_order: number };
export type Usage = { group_key: string; ingredient_code: string; qty_per_kg: number };
export type RmCount = { id: string; week_start: string; ingredient_code: string; qty: number; created_at: string; created_by_name: string | null };

export type LFn = (vi: string, en: string) => string;

export const MM_CLIENT = 'Maison Mooncake';
export const GREEN = '#1A4731';
export const BORDER = '#E5E7EB';
export const MUTED = '#6B7280';
export const FAINT = '#9CA3AF';

export const fmt = (n: number, d = 1) => (Math.round((n || 0) * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
export const localToday = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
export const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
export const itemKg = (it: Pick<Item, 'unit' | 'unit_weight_g'>, qty: number) => (it.unit === 'kg' ? qty : (qty * Number(it.unit_weight_g)) / 1000);
export const unitLabel = (it: Pick<Item, 'unit'>, L: LFn) => (it.unit === 'kg' ? 'kg' : L('gói', 'bags'));
export function mondayOf(iso: string) {
  const d = new Date(iso + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10);
}

export type Derived = {
  producedKg: Record<string, number>;      // per group — RECEIVED kg (Hung's real progress)
  pendingKg: Record<string, number>;       // per group — declared by Hung, not yet received
  declaredKg: Record<string, number>;      // per group — everything Hung declared
  packedQty: Record<string, number>;       // per sku (bags or kg), incl. packing found at inventory
  packedKg: Record<string, number>;        // per group
  scrapBulkKg: Record<string, number>;     // per group
  scrapFinished: Record<string, number>;   // per sku (faulty bags + negative inventory gaps)
  foundQty: Record<string, number>;        // per sku (unexplained surplus accepted by admin)
  deliveredQty: Record<string, number>;    // per sku (validated delivery checks)
  bulkAvail: Record<string, number>;       // per group — received − packed − broken bulk
  fgTheo: Record<string, number>;          // per sku — packed + found − delivered − faulty/lost
  targetKg: Record<string, number>;        // per group — initial target from the order
  remakeKg: Record<string, number>;        // per group — to re-make because of losses after reception
  toProduceKg: Record<string, number>;     // per group — target + re-make
};

export function derive(items: Item[], prod: ProdLog[], pack: PackLog[], deliveries: Delivery[]): Derived {
  const bySku: Record<string, Item> = {}; for (const i of items) bySku[i.sku] = i;
  const d: Derived = { producedKg: {}, pendingKg: {}, declaredKg: {}, packedQty: {}, packedKg: {}, scrapBulkKg: {}, scrapFinished: {}, foundQty: {}, deliveredQty: {}, bulkAvail: {}, fgTheo: {}, targetKg: {}, remakeKg: {}, toProduceKg: {} };
  const add = (m: Record<string, number>, k: string, v: number) => { m[k] = (m[k] ?? 0) + v; };
  for (const i of items) add(d.targetKg, i.group_key, itemKg(i, i.qty_ordered));
  for (const l of prod) {
    add(d.declaredKg, l.group_key, Number(l.weight_kg));
    if (l.status === 'received') add(d.producedKg, l.group_key, Number(l.received_kg ?? 0));
    else add(d.pendingKg, l.group_key, Number(l.weight_kg));
  }
  for (const p of pack) {
    const it = bySku[p.sku]; const q = Number(p.qty);
    if (p.kind === 'packed') { add(d.packedQty, p.sku, q); if (it) add(d.packedKg, p.group_key, itemKg(it, q)); }
    else if (p.kind === 'scrap_bulk') { add(d.scrapBulkKg, p.group_key, q); add(d.remakeKg, p.group_key, q); }
    else if (p.kind === 'scrap_finished') { add(d.scrapFinished, p.sku, q); if (it) add(d.remakeKg, p.group_key, itemKg(it, q)); }
    else if (p.kind === 'found') add(d.foundQty, p.sku, q);
  }
  for (const x of deliveries) if (x.order_status === 'validated' && !x.not_delivered && x.qty_checked != null) add(d.deliveredQty, x.sku, Number(x.qty_checked));
  const groups = new Set([...items.map(i => i.group_key), ...Object.keys(d.producedKg), ...Object.keys(d.pendingKg)]);
  groups.forEach(g => {
    d.bulkAvail[g] = (d.producedKg[g] ?? 0) - (d.packedKg[g] ?? 0) - (d.scrapBulkKg[g] ?? 0);
    d.toProduceKg[g] = (d.targetKg[g] ?? 0) + (d.remakeKg[g] ?? 0);
  });
  for (const i of items) d.fgTheo[i.sku] = (d.packedQty[i.sku] ?? 0) + (d.foundQty[i.sku] ?? 0) - (d.deliveredQty[i.sku] ?? 0) - (d.scrapFinished[i.sku] ?? 0);
  return d;
}

export type Group = { key: string; name: string; title: string; skus: string[]; items: Item[] };
// Real product name without the pack size ("Bánh quy socola nho khô 80g" → "Bánh quy socola nho khô").
export const baseName = (n: string) => n.replace(/\s*\(kg\)\s*$/i, '').replace(/\s+\d+\s*g$/i, '').trim();
export const GOLD = '#B8893B';
export const CREAM = '#F7F5F0';
export const LINE = '#EFE9DC';
export type Client = { name: string; groups: Group[] };
export function byClient(items: Item[]): Client[] {
  const m = new Map<string, Map<string, Item[]>>();
  for (const it of items) {
    const c = it.client_name || MM_CLIENT;
    if (!m.has(c)) m.set(c, new Map());
    const g = m.get(c)!; if (!g.has(it.group_key)) g.set(it.group_key, []); g.get(it.group_key)!.push(it);
  }
  return Array.from(m.entries()).map(([name, g]) => ({ name, groups: Array.from(g.entries()).map(([key, its]) => ({ key, name: its[0].group_name, title: baseName(its[0].product_name), skus: its.map(i => i.sku), items: its })) }));
}

// Quantity fields accept a tiny calculator (Axel, 2026-09-25: stock counted in several places —
// "12+3+50" kg of sugar; cartons: "12×24+7" = 12 cartons of 24 bags + 7 loose bags).
// Only digits, one decimal separator per number ("," or "."), "+" and "×" / "x" / "*".
// Returns null when empty, NaN when invalid, else the value (multiplication before addition).
export function evalQty(raw: string | undefined | null): number | null {
  const s = (raw ?? '').replace(/\s+/g, '').replace(/[xX×*]/g, '*').replace(/,/g, '.');
  if (!s) return null;
  if (!/^\d+(\.\d+)?([+*]\d+(\.\d+)?)*$/.test(s)) return NaN;
  const v = s.split('+').reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f), 1), 0);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : NaN;
}
export const hasOp = (raw: string | undefined | null) => /[+xX×*]/.test(raw ?? '');
// what the user may type in a quantity field
export const cleanExpr = (raw: string) => raw.replace(/[^0-9.,+xX×*\s]/g, '');

// value valid for a field? (empty = not filled; bags must be whole numbers)
export function qtyOk(raw: string | undefined | null, integer: boolean): boolean {
  const v = evalQty(raw);
  return v !== null && !Number.isNaN(v) && (!integer || Number.isInteger(v));
}
export function qtyBad(raw: string | undefined | null, integer: boolean): boolean {
  const v = evalQty(raw);
  return v !== null && (Number.isNaN(v) || (integer && !Number.isInteger(v)));
}
// gap needing an admin decision: > 20 bags (2 kg for cashews) or > 2 % of the theoretical stock
export function gapNeedsAdmin(gap: number, theo: number, unit: 'bag' | 'kg'): boolean {
  const abs = Math.abs(gap);
  return abs > (unit === 'kg' ? 2 : 20) || (theo > 0 && abs / theo > 0.02);
}
