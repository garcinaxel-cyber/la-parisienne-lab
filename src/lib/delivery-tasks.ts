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
  resolvedBy: string | null; resolvedAt: string | null;
};
export type RecountTask = { id: string; sku: string; product: string; deliveryDate: string | null; orderRef: string | null; missing: number; raisedBy: string | null; raisedAt: string };

// Supabase caps every request at 1000 rows: read page by page.
async function all(q: (from: number, to: number) => PromiseLike<{ data: any[] | null }>): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await q(f, f + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// .in() over long id lists: chunks of 150 (URL length), each read page by page.
async function inChunks(ids: string[], q: (chunk: string[], from: number, to: number) => PromiseLike<{ data: any[] | null }>): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 150) { const c = ids.slice(i, i + 150); out.push(...await all((f, t) => q(c, f, t))); }
  return out;
}

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
  const cards = await all((f, t) => sb.from('lab_assignments').select('id, import_id, variant_id, status, cancelled, is_extra, qty_produced, product_name_vi').in('import_id', iids).order('id').range(f, t));
  const vids = Array.from(new Set((cards ?? []).map((c: any) => c.variant_id).filter(Boolean)));
  const vars = await inChunks(vids, (c, f, t) => sb.from('lab_fiche_variants').select('id, sku, fiche_id').in('id', c).order('id').range(f, t));
  const fids = Array.from(new Set((vars ?? []).map((v: any) => v.fiche_id).filter(Boolean)));
  const fiches = await inChunks(fids, (c, f, t) => sb.from('lab_fiche_meta').select('id, category').in('id', c).order('id').range(f, t));
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
  const lines = await all((f, t) => sb.from('lab_delivery_check_lines').select('id, delivery_date, sku, qty_checked, status, delivery_order_id')
    .gte('delivery_date', from).lte('delivery_date', to).eq('category', 'production').order('id').range(f, t));
  const oids = Array.from(new Set((lines ?? []).map((l: any) => l.delivery_order_id)));
  const hdrs = await inChunks(oids, (c, f, t) => sb.from('lab_delivery_orders').select('id, marked_not_delivered').in('id', c).order('id').range(f, t));
  const notDelivered = new Set((hdrs ?? []).filter((h: any) => h.marked_not_delivered).map((h: any) => h.id));
  for (const l of lines ?? []) {
    const a = agg[`${l.delivery_date}|${l.sku}`]; if (!a || notDelivered.has(l.delivery_order_id)) continue;
    if (l.status === 'pending' || l.qty_checked == null) a.unchecked = true; else a.delivered += Number(l.qty_checked) || 0;
  }
  const losses = await all((f, t) => sb.from('lab_internal_losses').select('id, sku, qty, delivery_date, reported_at').gte('reported_at', `${from}T00:00:00+07:00`).order('id').range(f, t));
  for (const r of losses ?? []) {
    const d = r.delivery_date ?? labDateOf(r.reported_at); const a = agg[`${d}|${r.sku}`]; if (a) a.lost += Number(r.qty) || 0;
  }
  const { data: res } = await sb.from('lab_made_without_order').select('delivery_date, sku, product_name, qty, resolution, odoo_status, odoo_error, ref, resolved_at').gte('delivery_date', from);
  const resolved = new Set((res ?? []).map((r: any) => `${r.delivery_date}|${r.sku}`));
  const open = Object.values(agg)
    .filter(a => !a.unchecked)
    .map(a => ({ ...a, leftover: a.made - a.delivered - a.lost }))
    .filter(a => a.leftover > 0 && !resolved.has(`${a.date}|${a.sku}`))
    .map(({ unchecked: _u, ...a }) => a)
    .sort((x, y) => x.date.localeCompare(y.date));
  // A claim left 'pending' for more than 10 minutes was interrupted: show it as an error to retry.
  const stale = (r: any) => r.odoo_status === 'pending' && Date.now() - new Date(r.resolved_at).getTime() > 600_000;
  const done = (res ?? []).map((r: any) => ({ date: r.delivery_date, sku: r.sku, product: r.product_name ?? r.sku, qty: Number(r.qty), resolution: r.resolution, odooStatus: stale(r) ? 'error' : r.odoo_status, odooError: stale(r) ? 'Interrupted' : r.odoo_error, ref: r.ref }));
  return { open, done };
}

export async function loadProductionTasks(sb: SupabaseClient): Promise<{ open: ProdTask[]; resolved: ProdTask[]; recounts: RecountTask[] }> {
  const lines = await all((f, t) => sb.from('lab_delivery_check_lines')
    .select('id, delivery_order_id, delivery_date, sku, product_name_vi, product_category, category, qty_expected, qty_checked, discrepancy_reason, discrepancy_note, resolution, resolution_odoo_status, resolution_odoo_error, resolution_ref, resolution_by_name, resolution_at')
    .in('status', ['ok', 'adjusted']).gte('delivery_date', since()).order('id').range(f, t));
  // Weighed entries (decimals) are saved without a reason on purpose: not a task.
  const diff = (lines ?? []).filter((l: any) => Number(l.qty_checked ?? 0) !== Number(l.qty_expected ?? 0) && Number.isInteger(Number(l.qty_checked)) && Number.isInteger(Number(l.qty_expected)));
  const orderIds = Array.from(new Set(diff.map((l: any) => l.delivery_order_id).filter(Boolean)));
  const orders = await inChunks(orderIds, (c, f, t) => sb.from('lab_delivery_orders').select('id, order_ref, shop_name, customer_name, marked_not_delivered').in('id', c).order('id').range(f, t));
  const oById: Record<string, any> = {};
  for (const o of orders ?? []) oById[o.id] = o;
  const tasks: ProdTask[] = diff.filter((l: any) => !oById[l.delivery_order_id]?.marked_not_delivered).map((l: any) => {
    const o = oById[l.delivery_order_id] ?? {};
    return {
      id: l.id, deliveryDate: l.delivery_date, orderRef: o.order_ref ?? '', shop: o.shop_name ?? o.customer_name ?? null,
      sku: l.sku, product: l.product_name_vi ?? l.sku ?? '', family: l.product_category || l.category || '—',
      expected: Number(l.qty_expected ?? 0), checked: Number(l.qty_checked ?? 0),
      reason: l.discrepancy_reason, note: l.discrepancy_note, resolution: l.resolution,
      odooStatus: l.resolution_odoo_status, odooError: l.resolution_odoo_error, ref: l.resolution_ref, resolvedBy: l.resolution_by_name, resolvedAt: l.resolution_at,
    };
  });
  // 'pending' for more than 5 minutes = the follow-up was cut off: show it red (Retry).
  const stalePending = (t: ProdTask) => t.odooStatus === 'pending' && (!t.resolvedAt || Date.now() - new Date(t.resolvedAt).getTime() > 300_000);
  for (const t of tasks) if (stalePending(t)) { t.odooStatus = 'error'; t.odooError = t.odooError ?? 'Interrupted'; }
  const isOpen = (t: ProdTask) => !t.resolution || t.odooStatus === 'error';
  // Recount alerts removed from Tasks (Axel 2026-10-27: stock products are counted at the inventory).
  const rc: any[] = [];
  return {
    open: tasks.filter(isOpen).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.orderRef.localeCompare(b.orderRef) || a.product.localeCompare(b.product)),
    resolved: tasks.filter(t => !isOpen(t)),
    recounts: rc.map((r: any) => ({ id: r.id, sku: r.sku, product: r.product_name ?? r.sku, deliveryDate: r.delivery_date, orderRef: r.order_ref, missing: Number(r.missing_qty ?? 0), raisedBy: r.raised_by_name, raisedAt: r.raised_at })),
  };
}

// ONE count for the sidebar badge, the delivery-check card and the tasks page (review 2026-10-24:
// they disagreed). base = red tasks ① + ②; toSend = orders the Lab manager must still send to Odoo
// (added for admin / lab manager only, like the cards on the tasks page). Cached 60 s: it runs on
// every page.
export async function computeDeliveryTaskCount(sb: SupabaseClient): Promise<{ base: number; toSend: number }> {
  const { listDeliveryGaps } = await import('@/lib/reception-gaps');
  const [a, b, g, off] = await Promise.all([
    loadProductionTasks(sb), loadMadeWithoutOrder(sb), listDeliveryGaps(sb as any),
    sb.from('lab_offslip_items').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  const gaps = g.gaps;
  const loErr = b.done.filter(d => d.odooStatus === 'error').length;
  const reception = gaps.filter(x => x.kind !== 'damaged' && x.status === 'open').length + (off.count ?? 0);
  const send = new Set(gaps.filter(x => x.status === 'closed' && x.odooMode !== 'sent' && x.labCause !== 'shop_miscount' && !(x.kind === 'extra' && x.labCause !== 'lab_sent_extra')).map(x => x.deliveryOrderId)).size;
  return { base: a.open.length + b.open.length + loErr + reception, toSend: send };
}

export async function countOpenProductionTasks(sb: SupabaseClient): Promise<number> {
  try { return (await computeDeliveryTaskCount(sb)).base; } catch { return 0; }
}

// Amber "waiting for shops to confirm receipt" (Axel's mockup, 2026-10-24): La Paris shop orders
// of the last 7 days that left the Lab but have no receipt confirmed yet, counted per shop.
export async function loadShopsNotConfirmed(sb: SupabaseClient): Promise<{ shop: string; orders: number }[]> {
  const to = vnToday();
  const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: orders } = await sb.from('lab_delivery_orders').select('id, shop_name, customer_name, marked_not_delivered')
    .gte('delivery_date', from).lte('delivery_date', to).limit(2000);
  const shopOrders = (orders ?? []).filter((o: any) => !o.marked_not_delivered && /^(la paris|moon)/i.test(String(o.shop_name ?? o.customer_name ?? '')));
  const ids = shopOrders.map((o: any) => o.id);
  if (!ids.length) return [];
  const left = new Set<string>(); const received = new Set<string>();
  // Small chunks: Supabase returns at most 1000 rows per request (a big REP has 30+ lines).
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const [lines, rec] = await Promise.all([
      all((f, t) => sb.from('lab_delivery_check_lines').select('id, delivery_order_id').in('delivery_order_id', chunk).gt('qty_checked', 0).order('id').range(f, t)),
      all((f, t) => sb.from('lab_shop_receipt_lines').select('id, delivery_order_id').in('delivery_order_id', chunk).not('qty_received', 'is', null).order('id').range(f, t)),
    ]);
    for (const l of lines ?? []) left.add(l.delivery_order_id);
    for (const r of rec ?? []) received.add(r.delivery_order_id);
  }
  const by: Record<string, number> = {};
  for (const o of shopOrders) if (left.has(o.id) && !received.has(o.id)) {
    const name = String(o.shop_name ?? o.customer_name).replace(/^La Paris\s*/i, '');
    by[name] = (by[name] ?? 0) + 1;
  }
  return Object.entries(by).map(([shop, orders]) => ({ shop, orders })).sort((a, b) => b.orders - a.orders);
}
