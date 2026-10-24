import type { SupabaseClient } from '@supabase/supabase-js';
import { isStockFamily } from '@/lib/delivery-check-production';
import { labDateOf } from '@/lib/odoo';

// "Tasks · Delivery gaps" (Axel, 2026-10-24). Section ① Production → delivery: every delivery-check
// line whose count differs from the order gets a reason + an automatic follow-up (delivery-gap.ts).
// A line is still a red task when that follow-up never ran or Odoo refused it. Section ② (shop
// receptions) stays computed by reception-gaps.ts. Only lines checked from the release day count —
// older differences were settled by hand before this existed.
export const TASKS_SINCE = '2026-10-25';

export type ProdTask = {
  id: string; deliveryDate: string; orderRef: string; shop: string | null;
  sku: string | null; product: string; family: string;
  expected: number; checked: number; reason: string | null; note: string | null;
  resolution: string | null; odooStatus: string | null; odooError: string | null; ref: string | null;
  resolvedBy: string | null;
};
export type RecountTask = { id: string; sku: string; product: string; deliveryDate: string | null; orderRef: string | null; missing: number; raisedBy: string | null; raisedAt: string };

function vnToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function since(): string {
  const d7 = new Date(new Date(`${vnToday()}T00:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  return d7 > TASKS_SINCE ? d7 : TASKS_SINCE;
}

export type LeftoverTask = { date: string; sku: string; product: string; family: string; made: number; delivered: number; lost: number; leftover: number };
export type LeftoverDone = { date: string; sku: string; product: string; qty: number; resolution: string; odooStatus: string | null; odooError: string | null; ref: string | null };

// "Made without order" (Axel, 2026-10-24): per lab day × made-to-order product, once every
// delivery line of that product is checked, what the kitchen declared minus what left (orders)
// minus Lab losses. > 0 → somebody must say where those units are.
export async function loadMadeWithoutOrder(sb: SupabaseClient): Promise<{ open: LeftoverTask[]; done: LeftoverDone[] }> {
  const from = since(); const to = vnToday();
  const { data: imports } = await sb.from('lab_imports').select('id, delivery_date').gte('delivery_date', from).lte('delivery_date', to);
  const dateByImport: Record<string, string> = {};
  for (const i of imports ?? []) dateByImport[i.id] = i.delivery_date;
  const iids = Object.keys(dateByImport);
  if (!iids.length) return { open: [], done: [] };
  const { data: cards } = await sb.from('lab_assignments').select('import_id, variant_id, status, cancelled, is_extra, qty_produced, product_name_vi').in('import_id', iids).limit(10000);
  const vids = Array.from(new Set((cards ?? []).map((c: any) => c.variant_id).filter(Boolean)));
  const { data: vars } = vids.length ? await sb.from('lab_fiche_variants').select('id, sku, fiche_id').in('id', vids) : { data: [] as any[] };
  const fids = Array.from(new Set((vars ?? []).map((v: any) => v.fiche_id).filter(Boolean)));
  const { data: fiches } = fids.length ? await sb.from('lab_fiche_meta').select('id, category').in('id', fids) : { data: [] as any[] };
  const catByFiche: Record<string, string> = {}; for (const f of fiches ?? []) catByFiche[f.id] = f.category;
  const varById: Record<string, { sku: string; cat: string }> = {};
  for (const v of vars ?? []) if (v.sku) varById[v.id] = { sku: v.sku, cat: catByFiche[v.fiche_id] ?? '' };
  type Agg = { date: string; sku: string; product: string; family: string; made: number; delivered: number; lost: number; unchecked: boolean };
  const agg: Record<string, Agg> = {};
  for (const c of cards ?? []) {
    const v = varById[c.variant_id]; const date = dateByImport[c.import_id];
    if (!v || !date || c.cancelled || c.is_extra || c.status === 'skip' || c.status === 'blocked') continue;
    if (isStockFamily(v.cat)) continue;
    const k = `${date}|${v.sku}`;
    const a = (agg[k] ??= { date, sku: v.sku, product: c.product_name_vi, family: v.cat || '—', made: 0, delivered: 0, lost: 0, unchecked: false });
    a.made += Number(c.qty_produced) || 0;
  }
  if (!Object.keys(agg).length) return { open: [], done: [] };
  const { data: lines } = await sb.from('lab_delivery_check_lines').select('delivery_date, sku, qty_checked, status, delivery_order_id')
    .gte('delivery_date', from).lte('delivery_date', to).eq('category', 'production').limit(10000);
  const oids = Array.from(new Set((lines ?? []).map((l: any) => l.delivery_order_id)));
  const { data: hdrs } = oids.length ? await sb.from('lab_delivery_orders').select('id, marked_not_delivered').in('id', oids) : { data: [] as any[] };
  const notDelivered = new Set((hdrs ?? []).filter((h: any) => h.marked_not_delivered).map((h: any) => h.id));
  for (const l of lines ?? []) {
    const a = agg[`${l.delivery_date}|${l.sku}`]; if (!a || notDelivered.has(l.delivery_order_id)) continue;
    if (l.status === 'pending' || l.qty_checked == null) a.unchecked = true; else a.delivered += Number(l.qty_checked) || 0;
  }
  const { data: losses } = await sb.from('lab_internal_losses').select('sku, qty, delivery_date, reported_at').gte('reported_at', `${from}T00:00:00+07:00`).limit(5000);
  for (const r of losses ?? []) {
    const d = r.delivery_date ?? labDateOf(r.reported_at); const a = agg[`${d}|${r.sku}`]; if (a) a.lost += Number(r.qty) || 0;
  }
  const { data: res } = await sb.from('lab_made_without_order').select('delivery_date, sku, product_name, qty, resolution, odoo_status, odoo_error, ref').gte('delivery_date', from);
  const resolved = new Set((res ?? []).map((r: any) => `${r.delivery_date}|${r.sku}`));
  const open = Object.values(agg)
    .filter(a => !a.unchecked)
    .map(a => ({ ...a, leftover: a.made - a.delivered - a.lost }))
    .filter(a => a.leftover > 0 && !resolved.has(`${a.date}|${a.sku}`))
    .map(({ unchecked: _u, ...a }) => a)
    .sort((x, y) => x.date.localeCompare(y.date));
  const done = (res ?? []).map((r: any) => ({ date: r.delivery_date, sku: r.sku, product: r.product_name ?? r.sku, qty: Number(r.qty), resolution: r.resolution, odooStatus: r.odoo_status, odooError: r.odoo_error, ref: r.ref }));
  return { open, done };
}

export async function loadProductionTasks(sb: SupabaseClient): Promise<{ open: ProdTask[]; resolved: ProdTask[]; recounts: RecountTask[] }> {
  const { data: lines } = await sb.from('lab_delivery_check_lines')
    .select('id, delivery_order_id, delivery_date, sku, product_name_vi, product_category, category, qty_expected, qty_checked, discrepancy_reason, discrepancy_note, resolution, resolution_odoo_status, resolution_odoo_error, resolution_ref, resolution_by_name')
    .in('status', ['ok', 'adjusted']).gte('delivery_date', since()).limit(5000);
  const diff = (lines ?? []).filter((l: any) => Number(l.qty_checked ?? 0) !== Number(l.qty_expected ?? 0));
  const orderIds = Array.from(new Set(diff.map((l: any) => l.delivery_order_id).filter(Boolean)));
  const { data: orders } = orderIds.length
    ? await sb.from('lab_delivery_orders').select('id, order_ref, shop_name, customer_name, marked_not_delivered').in('id', orderIds)
    : { data: [] as any[] };
  const oById: Record<string, any> = {};
  for (const o of orders ?? []) oById[o.id] = o;
  const tasks: ProdTask[] = diff.filter((l: any) => !oById[l.delivery_order_id]?.marked_not_delivered).map((l: any) => {
    const o = oById[l.delivery_order_id] ?? {};
    return {
      id: l.id, deliveryDate: l.delivery_date, orderRef: o.order_ref ?? '', shop: o.shop_name ?? o.customer_name ?? null,
      sku: l.sku, product: l.product_name_vi ?? l.sku ?? '', family: l.product_category || l.category || '—',
      expected: Number(l.qty_expected ?? 0), checked: Number(l.qty_checked ?? 0),
      reason: l.discrepancy_reason, note: l.discrepancy_note, resolution: l.resolution,
      odooStatus: l.resolution_odoo_status, odooError: l.resolution_odoo_error, ref: l.resolution_ref, resolvedBy: l.resolution_by_name,
    };
  });
  const isOpen = (t: ProdTask) => !t.resolution || t.odooStatus === 'error';
  const { data: rc } = await sb.from('lab_stock_recount_alerts')
    .select('id, sku, product_name, delivery_date, order_ref, missing_qty, raised_by_name, raised_at').eq('status', 'open').order('raised_at').limit(200);
  return {
    open: tasks.filter(isOpen).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate)),
    resolved: tasks.filter(t => !isOpen(t)),
    recounts: (rc ?? []).map((r: any) => ({ id: r.id, sku: r.sku, product: r.product_name ?? r.sku, deliveryDate: r.delivery_date, orderRef: r.order_ref, missing: Number(r.missing_qty ?? 0), raisedBy: r.raised_by_name, raisedAt: r.raised_at })),
  };
}

// Cheap count for the sidebar badge (red tasks of section ① only — section ② has its own tabs).
export async function countOpenProductionTasks(sb: SupabaseClient): Promise<number> {
  try {
    const [a, b] = await Promise.all([loadProductionTasks(sb), loadMadeWithoutOrder(sb)]);
    return a.open.length + b.open.length + b.done.filter(d => d.odooStatus === 'error').length;
  } catch { return 0; }
}
