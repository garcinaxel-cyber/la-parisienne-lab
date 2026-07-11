import type { SupabaseClient } from '@supabase/supabase-js';

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

export type OdooChange = {
  order_ref: string;
  cancelled?: boolean;
  items: { sku: string; name?: string; old_qty?: number; new_qty: number }[];
};

// Apply Odoo modifications to already-imported orders:
//  - qty changed on an existing product → adjust line + assignment (± delta)
//  - product ADDED to the order (old qty 0, no lab line) → create the line and,
//    if the SKU resolves to a fiche+team, create/merge the production card
//  - cancellation → the item new_qty is 0, handled by the delta path
// Produced qty is preserved; only planned totals move. Shared by the manual
// apply endpoint and the pending-changes queue.
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

      // ── New product added to an existing order ──
      if (!olRows?.length) {
        if (item.new_qty <= 0) continue;
        const created = await createLineAndCard(supabase, ch.order_ref, item, today);
        if (created.error) errors.push(`${ch.order_ref}/${item.sku}: ${created.error}`);
        else applied.push(`${ch.order_ref}/${item.sku}: new +${item.new_qty}`);
        continue;
      }

      // ── Existing product, qty changed ──
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
        const newTotal = Math.max(0, (asg.total_qty ?? 0) + delta);
        // Whole card down to 0 → mark cancelled (kept visible, struck through, out of progress).
        // Re-added later (total back above 0) → un-cancel.
        await supabase.from('lab_assignments').update({
          total_qty: newTotal,
          qty_to_produce: Math.max(0, (asg.qty_to_produce ?? 0) + delta),
          cancelled: newTotal === 0,
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

// Create a lab_order_lines row for a product newly added to an existing order,
// and create/merge the production card when the SKU has a fiche+team.
async function createLineAndCard(
  supabase: SupabaseClient,
  orderRef: string,
  item: { sku: string; name?: string; new_qty: number },
  today: string,
): Promise<{ error?: string }> {
  // Context (import, shop, dates) from an existing line of the same order
  const { data: ctxRows } = await supabase
    .from('lab_order_lines')
    .select('import_id, shop_name, delivery_date, delivery_time, source_type')
    .eq('order_ref', orderRef)
    .gte('delivery_date', today)
    .limit(1);
  const ctx = ctxRows?.[0];
  if (!ctx) return { error: 'order not found in lab — re-import it' };

  // Resolve SKU → variant → fiche (team, name_en, image)
  const { data: v } = await supabase
    .from('lab_fiche_variants').select('id, label, fiche_id, image_url').eq('sku', item.sku).limit(1).maybeSingle();
  let team = '', variantLabel = 'Standard';
  let ficheId: string | null = null, variantId: string | null = null, nameEn = '', image: string | null = null;
  if (v) {
    ficheId = v.fiche_id; variantId = v.id; variantLabel = v.label ?? 'Standard'; image = v.image_url ?? null;
    const { data: f } = await supabase.from('lab_fiche_meta').select('name_en, image_url, teams').eq('id', v.fiche_id).single();
    team = (f?.teams ?? [])[0] ?? '';
    nameEn = f?.name_en ?? ''; image = image ?? f?.image_url ?? null;
  }

  const name = item.name ?? item.sku;

  // Insert the order line
  await supabase.from('lab_order_lines').insert({
    import_id: ctx.import_id, source_type: ctx.source_type, order_ref: orderRef,
    shop_name: ctx.shop_name, product_sku: item.sku, product_name_vi: name,
    team, variant_label: variantLabel, qty: item.new_qty,
    delivery_date: ctx.delivery_date, delivery_time: ctx.delivery_time,
    fiche_id: ficheId, variant_id: variantId,
  });

  // Production card only if a team resolved (no fiche → shows in publish-bar unmatched)
  if (team && TEAMS.includes(team)) {
    const { data: asgEx } = await supabase
      .from('lab_assignments').select('id, total_qty, qty_to_produce, breakdown')
      .eq('import_id', ctx.import_id).eq('team', team).eq('variant_label', variantLabel).eq('product_name_vi', name);
    const asg = asgEx?.[0];
    const bEntry = { shop_name: ctx.shop_name, order_ref: orderRef, qty: item.new_qty, delivery_time: ctx.delivery_time ?? null };
    if (asg) {
      const breakdown = Array.isArray(asg.breakdown) ? [...asg.breakdown, bEntry] : [bEntry];
      await supabase.from('lab_assignments').update({
        total_qty: (asg.total_qty ?? 0) + item.new_qty,
        qty_to_produce: (asg.qty_to_produce ?? 0) + item.new_qty,
        cancelled: false, // demand came back
        breakdown, updated_at: new Date().toISOString(),
      }).eq('id', asg.id);
    } else {
      await supabase.from('lab_assignments').insert({
        import_id: ctx.import_id, team, fiche_id: ficheId, variant_id: variantId,
        product_name_vi: name, product_name_en: nameEn, image_url: image,
        variant_label: variantLabel, total_qty: item.new_qty, qty_to_produce: item.new_qty, qty_produced: 0,
        status: 'pending', sort_order: 6000, breakdown: [bEntry],
      });
    }
  }
  return {};
}
