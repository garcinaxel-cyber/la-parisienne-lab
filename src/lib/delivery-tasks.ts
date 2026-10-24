import type { SupabaseClient } from '@supabase/supabase-js';

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

export async function loadProductionTasks(sb: SupabaseClient): Promise<{ open: ProdTask[]; resolved: ProdTask[]; recounts: RecountTask[] }> {
  const { data: lines } = await sb.from('lab_delivery_check_lines')
    .select('id, delivery_order_id, delivery_date, sku, product_name_vi, product_category, category, qty_expected, qty_checked, discrepancy_reason, discrepancy_note, resolution, resolution_odoo_status, resolution_odoo_error, resolution_ref, resolution_by_name')
    .eq('status', 'checked').gte('delivery_date', since()).limit(5000);
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
  try { return (await loadProductionTasks(sb)).open.length; } catch { return 0; }
}
