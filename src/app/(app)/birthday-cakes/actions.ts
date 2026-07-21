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
  revalidatePath('/exceptional-orders');
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
  customerName: string | null; customerPhone: string | null; notes?: string | null;
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
    notes: input.notes ?? null,
    needs_odoo: true, assignment_id: asg.id, import_id: importId,
    created_by: session.user.id, created_by_name: profile?.full_name ?? null,
  });
  if (mcErr) { await supabase.from('lab_assignments').delete().eq('id', asg.id); return { error: mcErr.message }; }

  revalidatePath('/birthday-cakes');
  revalidatePath('/exceptional-orders');
  return { ok: true };
}

// Edit the complementary fields of a manual cake (mirrors saveBirthdayDetailAction)
export async function updateManualCakeAction(
  id: string,
  fields: {
    message?: string | null; readyTime?: string | null; deliveredBy?: string | null; deliveryAddress?: string | null;
    notes?: string | null; customerName?: string | null; customerPhone?: string | null;
  },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const update: any = {
    message: fields.message ?? null, ready_time: fields.readyTime ?? null,
    delivered_by: fields.deliveredBy ?? null, delivery_address: fields.deliveryAddress ?? null,
  };
  // Only touch the newer columns when provided — callers that don't know them leave them intact
  if (fields.notes !== undefined) update.notes = fields.notes;
  if (fields.customerName !== undefined) update.customer_name = fields.customerName;
  if (fields.customerPhone !== undefined) update.customer_phone = fields.customerPhone;
  const { error } = await supabase.from('lab_manual_cakes').update(update).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/birthday-cakes');
  revalidatePath('/exceptional-orders');
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
  revalidatePath('/exceptional-orders');
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
  revalidatePath('/exceptional-orders');
  return { ok: true };
}

// "Not this one" — the suggested Odoo order is NOT this manual cake. Remember the rejection so
// we stop suggesting it, and create the Odoo order's own production card (the pipeline had skipped it).
export async function rejectMatchAction(manualCakeId: string, orderRef: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const { data: mc } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, delivery_date, rejected_order_refs').eq('id', manualCakeId).maybeSingle();
  if (!mc) return { error: 'Cake not found' };

  const rejected = Array.from(new Set([...(mc.rejected_order_refs ?? []), orderRef]));
  await supabase.from('lab_manual_cakes').update({ rejected_order_refs: rejected }).eq('id', manualCakeId);

  // Create the production card for that order's line(s), which the pipeline skipped.
  const { data: oLines } = await supabase.from('lab_order_lines')
    .select('id, import_id, team, variant_label, product_name_vi, product_sku, shop_name, qty, delivery_time')
    .eq('order_ref', orderRef).eq('product_sku', mc.product_sku).eq('delivery_date', mc.delivery_date);
  if (!oLines?.length) return { ok: true };

  const skus = Array.from(new Set(oLines.map((l: any) => l.product_sku).filter(Boolean)));
  const { data: variants } = await supabase.from('lab_fiche_variants').select('id, sku, label, fiche_id, image_url').in('sku', skus);
  const vBySku: Record<string, any> = {};
  for (const v of variants ?? []) if (v.sku) vBySku[v.sku] = v;
  const ficheIds = Array.from(new Set((variants ?? []).map((v: any) => v.fiche_id).filter(Boolean)));
  const { data: fiches } = ficheIds.length ? await supabase.from('lab_fiche_meta').select('id, name_en, image_url, teams').in('id', ficheIds) : { data: [] as any[] };
  const fById: Record<string, any> = {};
  for (const f of fiches ?? []) fById[f.id] = f;

  const TEAMS4 = ['baby_mama', 'hung', 'entremet', 'baker'];
  const groups = new Map<string, any>();
  for (const l of oLines) {
    const v = l.product_sku ? vBySku[l.product_sku] : null; if (!v) continue;
    const f = fById[v.fiche_id]; const team = (f?.teams ?? [])[0] ?? '';
    if (!TEAMS4.includes(team)) continue;
    const variantLabel = v.label ?? l.variant_label ?? 'Standard';
    const key = `${l.import_id}||${team}||${variantLabel}||${l.product_name_vi}`;
    const g = groups.get(key) ?? { import_id: l.import_id, team, variant_label: variantLabel, name: l.product_name_vi, fiche_id: v.fiche_id, variant_id: v.id, name_en: f?.name_en ?? '', image_url: v.image_url ?? f?.image_url ?? null, total: 0, breakdown: [] as any[] };
    g.total += l.qty ?? 0;
    g.breakdown.push({ shop_name: l.shop_name, order_ref: orderRef, qty: l.qty, delivery_time: l.delivery_time ?? null });
    groups.set(key, g);
  }
  const rows = Array.from(groups.values()).filter((g: any) => g.total > 0).map((g: any, idx: number) => ({
    import_id: g.import_id, team: g.team, fiche_id: g.fiche_id, variant_id: g.variant_id,
    product_name_vi: g.name, product_name_en: g.name_en, image_url: g.image_url, variant_label: g.variant_label,
    total_qty: g.total, qty_to_produce: g.total, qty_produced: 0, status: 'pending', sort_order: 5000 + idx, breakdown: g.breakdown,
  }));
  if (rows.length) await supabase.from('lab_assignments').insert(rows);

  revalidatePath('/birthday-cakes');
  revalidatePath('/exceptional-orders');
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
  revalidatePath('/exceptional-orders');
  return { ok: true };
}
