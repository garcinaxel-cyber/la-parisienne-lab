import type { SupabaseClient } from '@supabase/supabase-js';

export type OdooChange = {
  order_ref: string;
  cancelled?: boolean;
  items: { sku: string; name?: string; old_qty?: number; new_qty: number }[];
};

// Apply Odoo modifications to already-imported orders. For each item: set the new
// qty on lab_order_lines and adjust the matching assignment (total_qty / qty_to_produce
// ± delta, breakdown entry, audit note). Produced qty is preserved (only planned totals move).
// Shared by the manual apply endpoint and the pending-changes queue.
export async function applyOdooChanges(supabase: SupabaseClient, changes: OdooChange[]) {
  const today = new Date().toISOString().split('T')[0];
  const applied: string[] = [];
  const errors: string[] = [];

  for (const ch of changes) {
    for (const item of ch.items) {
      const { data: olRows } = await supabase
        .from('lab_order_lines')
        .select('id, qty, import_id, team, variant_label, product_name_vi, shop_name')
        .eq('order_ref', ch.order_ref)
        .eq('product_sku', item.sku)
        .gte('delivery_date', today);
      if (!olRows?.length) {
        if (item.new_qty > 0) errors.push(`${ch.order_ref}/${item.sku}: new line — re-import to add it`);
        continue;
      }
      const oldTotal = olRows.reduce((s, r) => s + (r.qty ?? 0), 0);
      const delta = item.new_qty - oldTotal;
      if (delta === 0) continue;

      const [first, ...rest] = olRows;
      await supabase.from('lab_order_lines').update({ qty: item.new_qty }).eq('id', first.id);
      for (const r of rest) await supabase.from('lab_order_lines').update({ qty: 0 }).eq('id', r.id);

      const { data: asgRows } = await supabase
        .from('lab_assignments')
        .select('id, total_qty, qty_to_produce, breakdown, notes')
        .eq('import_id', first.import_id)
        .eq('team', first.team)
        .eq('variant_label', first.variant_label)
        .eq('product_name_vi', first.product_name_vi);
      const asg = asgRows?.[0];
      if (asg) {
        const breakdown = Array.isArray(asg.breakdown) ? [...asg.breakdown] : [];
        const bIdx = breakdown.findIndex((b: any) => b.order_ref === ch.order_ref);
        if (bIdx >= 0) breakdown[bIdx] = { ...breakdown[bIdx], qty: item.new_qty };
        const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
        const note = ch.cancelled
          ? `⚠ ${ch.order_ref} annulée dans Odoo (−${oldTotal})`
          : `Odoo ${stamp}: ${ch.order_ref} ${delta > 0 ? '+' : ''}${delta}`;
        await supabase.from('lab_assignments').update({
          total_qty: Math.max(0, (asg.total_qty ?? 0) + delta),
          qty_to_produce: Math.max(0, (asg.qty_to_produce ?? 0) + delta),
          breakdown,
          notes: asg.notes ? `${asg.notes}\n${note}` : note,
          updated_at: new Date().toISOString(),
        }).eq('id', asg.id);
      }
      applied.push(`${ch.order_ref}/${item.sku}: ${oldTotal} → ${item.new_qty}`);
    }
  }
  return { applied, errors };
}
