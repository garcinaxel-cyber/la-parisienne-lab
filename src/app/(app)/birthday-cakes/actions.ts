'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

// Upsert the complementary info attached to ONE birthday-cake order line.
// Never creates or duplicates an order — only the extra fields, keyed by order_line_id.
export async function saveBirthdayDetailAction(
  orderLineId: string,
  fields: { message?: string | null; readyTime?: string | null; deliveredBy?: string | null; deliveryAddress?: string | null },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const { error } = await supabase.from('lab_birthday_details').upsert({
    order_line_id: orderLineId,
    message: fields.message ?? null,
    ready_time: fields.readyTime ?? null,
    delivered_by: fields.deliveredBy ?? null,
    delivery_address: fields.deliveryAddress ?? null,
    updated_by: session.user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'order_line_id' });
  if (error) return { error: error.message };

  revalidatePath('/birthday-cakes');
  return { ok: true };
}

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];
const MANUAL_MARK = '__manual_cakes__';

// Create a birthday cake directly in the app (before it exists in Odoo). Produces a
// production card for the chefs immediately + records it as "to enter in Odoo".
export async function createManualCakeAction(input: {
  ficheId: string; variantId: string | null; sku: string | null;
  nameVi: string; nameEn: string; imageUrl: string | null; team: string;
  qty: number; deliveryDate: string; readyTime: string | null;
  deliveredBy: string | null; deliveryAddress: string | null; message: string | null;
  customerName: string | null; customerPhone: string | null;
}): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  if (!TEAMS.includes(input.team)) return { error: 'Product has no valid team — complete the recipe card' };
  if (!input.qty || input.qty < 1) return { error: 'Invalid quantity' };
  if (!input.deliveryDate) return { error: 'Missing delivery date' };

  // Find or create the per-day "manual" container (one per day, reused)
  let importId: string;
  const { data: existing } = await supabase.from('lab_imports')
    .select('id').eq('delivery_date', input.deliveryDate).eq('type', 'cake_addon').eq('notes', MANUAL_MARK).eq('status', 'published').limit(1).maybeSingle();
  if (existing?.id) importId = existing.id;
  else {
    const { data: maxRow } = await supabase.from('lab_imports').select('order_number').eq('delivery_date', input.deliveryDate).order('order_number', { ascending: false }).limit(1).maybeSingle();
    const orderNumber = (maxRow?.order_number ?? 0) + 1;
    const { data: imp, error: impErr } = await supabase.from('lab_imports').insert({
      delivery_date: input.deliveryDate, order_number: orderNumber, type: 'cake_addon', status: 'published',
      notes: MANUAL_MARK, published_at: new Date().toISOString(), published_by: session.user.id,
    }).select('id').single();
    if (impErr || !imp) return { error: impErr?.message ?? 'Container error' };
    importId = imp.id;
  }

  // Production card visible to the chefs right away
  const { data: asg, error: asgErr } = await supabase.from('lab_assignments').insert({
    import_id: importId, team: input.team, fiche_id: input.ficheId, variant_id: input.variantId,
    product_name_vi: input.nameVi, product_name_en: input.nameEn, image_url: input.imageUrl,
    variant_label: 'Standard', total_qty: input.qty, qty_to_produce: input.qty, qty_produced: 0,
    status: 'pending', sort_order: 9000, breakdown: [],
  }).select('id').single();
  if (asgErr || !asg) return { error: asgErr?.message ?? 'Card error' };

  const { error: mcErr } = await supabase.from('lab_manual_cakes').insert({
    fiche_id: input.ficheId, variant_id: input.variantId, product_sku: input.sku,
    product_name_vi: input.nameVi, product_name_en: input.nameEn, image_url: input.imageUrl,
    team: input.team, qty: input.qty, delivery_date: input.deliveryDate,
    ready_time: input.readyTime, delivered_by: input.deliveredBy, delivery_address: input.deliveryAddress,
    message: input.message, customer_name: input.customerName, customer_phone: input.customerPhone,
    needs_odoo: true, assignment_id: asg.id, import_id: importId,
    created_by: session.user.id, created_by_name: profile?.full_name ?? null,
  });
  if (mcErr) { await supabase.from('lab_assignments').delete().eq('id', asg.id); return { error: mcErr.message }; }

  revalidatePath('/birthday-cakes');
  return { ok: true };
}

// Edit the complementary fields of a manual cake (mirrors saveBirthdayDetailAction)
export async function updateManualCakeAction(
  id: string,
  fields: { message?: string | null; readyTime?: string | null; deliveredBy?: string | null; deliveryAddress?: string | null },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_manual_cakes').update({
    message: fields.message ?? null, ready_time: fields.readyTime ?? null,
    delivered_by: fields.deliveredBy ?? null, delivery_address: fields.deliveryAddress ?? null,
  }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/birthday-cakes');
  return { ok: true };
}

// Mark a manual cake as entered in Odoo (Phase 1 manual clear; Phase 2 will auto-match)
export async function markManualCakeEnteredAction(id: string, entered: boolean): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_manual_cakes').update({ needs_odoo: !entered }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/birthday-cakes');
  return { ok: true };
}

// Phase 2 — link a manual cake to the Odoo order that now carries it (human-confirmed).
// The manual production card is KEPT (produced qty preserved); the Odoo order's duplicate
// contribution is removed from its production card (subtract this order's lines), and the
// manual cake's info is copied onto the Odoo order line so nothing is lost.
export async function confirmMatchAction(manualCakeId: string, orderRef: string, targetSku?: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const { data: mc } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, delivery_date, message, ready_time, delivered_by, delivery_address').eq('id', manualCakeId).maybeSingle();
  if (!mc) return { error: 'Cake not found' };

  // The Odoo order line(s) this manual cake covers. Auto-match uses the manual cake's SKU;
  // a human "Link to order" passes the picked Odoo line's SKU (works even if the fiche SKU differs).
  const sku = targetSku || mc.product_sku;
  let q = supabase.from('lab_order_lines')
    .select('id, import_id, team, variant_label, product_name_vi, qty')
    .eq('order_ref', orderRef).eq('delivery_date', mc.delivery_date);
  q = sku ? q.eq('product_sku', sku) : q;
  const { data: oLines } = await q;
  if (!oLines?.length) return { error: 'Odoo order line not found' };

  // Copy the manual cake's complementary info onto the Odoo order line(s)
  for (const l of oLines) {
    await supabase.from('lab_birthday_details').upsert({
      order_line_id: l.id, message: mc.message, ready_time: mc.ready_time,
      delivered_by: mc.delivered_by, delivery_address: mc.delivery_address,
      updated_by: session.user.id, updated_at: new Date().toISOString(),
    }, { onConflict: 'order_line_id' });
  }

  // Remove THIS order's contribution from the Odoo production card(s) so nothing is produced
  // twice. Only this order_ref is subtracted — other orders on the same card are untouched.
  const importIds = Array.from(new Set(oLines.map((l: any) => l.import_id)));
  const keys = new Set(oLines.map((l: any) => `${l.import_id}||${l.team}||${l.variant_label}||${l.product_name_vi}`));
  const { data: cards } = importIds.length
    ? await supabase.from('lab_assignments').select('id, import_id, team, variant_label, product_name_vi, qty_produced, breakdown').in('import_id', importIds)
    : { data: [] as any[] };
  for (const c of cards ?? []) {
    if (!keys.has(`${c.import_id}||${c.team}||${c.variant_label}||${c.product_name_vi}`)) continue;
    const bd = (Array.isArray(c.breakdown) ? c.breakdown : []).filter((b: any) => b.order_ref !== orderRef);
    const remaining = bd.reduce((s: number, b: any) => s + (b.qty ?? 0), 0);
    if (remaining <= 0) {
      await supabase.from('lab_assignments').delete().eq('id', c.id);
    } else {
      await supabase.from('lab_assignments').update({
        breakdown: bd, total_qty: remaining, qty_to_produce: remaining,
        qty_produced: Math.min(c.qty_produced ?? 0, remaining),
      }).eq('id', c.id);
    }
  }

  await supabase.from('lab_manual_cakes')
    .update({ matched_order_ref: orderRef, matched_at: new Date().toISOString(), needs_odoo: false })
    .eq('id', manualCakeId);

  revalidatePath('/birthday-cakes');
  return { ok: true };
}

// Delete a manual cake (and its production card)
export async function deleteManualCakeAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const { data: cake } = await supabase.from('lab_manual_cakes').select('assignment_id').eq('id', id).maybeSingle();
  if (cake?.assignment_id) await supabase.from('lab_assignments').delete().eq('id', cake.assignment_id);
  const { error } = await supabase.from('lab_manual_cakes').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/birthday-cakes');
  return { ok: true };
}
