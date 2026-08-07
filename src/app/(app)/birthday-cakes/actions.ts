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

  // Guard against two DIFFERENT manual cakes both getting confirmed onto the same Odoo order —
  // manual-cake-coverage.ts sums qty per (order_ref, product_sku, delivery_date), so a second
  // cake matched to the same trio would double-count coverage against one real Odoo line and
  // could mask genuine extra demand later. Keyed on mc.product_sku (the cake's OWN sku — what
  // coverage is actually computed from), not the picked line's sku, since a provisional "link to
  // a different product's line" (below) still uses the cake's own sku as the coverage key.
  if (mc.product_sku) {
    const { data: already } = await supabase.from('lab_manual_cakes')
      .select('id').eq('matched_order_ref', orderRef).eq('product_sku', mc.product_sku)
      .eq('delivery_date', mc.delivery_date).is('cancelled_at', null).neq('id', manualCakeId).maybeSingle();
    if (already) return { error: `${orderRef} is already linked to another manual order for this same product — check for a duplicate before confirming` };
  }

  // The Odoo order line(s) this manual cake covers. Auto-match uses the manual cake's SKU;
  // a human "Link to order" passes the picked Odoo line's SKU (works even if the fiche SKU differs).
  const sku = targetSku || mc.product_sku;
  const sameProduct = sku === mc.product_sku;
  let q = supabase.from('lab_order_lines')
    .select('id, import_id, team, variant_label, product_name_vi, qty')
    .eq('order_ref', orderRef).eq('delivery_date', mc.delivery_date);
  q = sku ? q.eq('product_sku', sku) : q;
  const { data: oLines } = await q;

  // Provisional link: a human picked a DIFFERENT product's line because the cake's own SKU
  // isn't on the Odoo order yet (product not added there yet). Only confirm the order exists
  // for that date and record the match — never copy the birthday message onto that other
  // product's line, and never subtract from that other product's production card. It isn't
  // the same item, so nothing about it should change. Once the real SKU line syncs in later,
  // manual-cake-coverage.ts (keyed on the cake's own SKU, not this placeholder) picks it up
  // correctly on its own.
  if (!sameProduct) {
    const { data: anyLine } = await supabase.from('lab_order_lines')
      .select('id').eq('order_ref', orderRef).eq('delivery_date', mc.delivery_date).limit(1);
    if (!anyLine?.length) return { error: 'Odoo order not found for this date' };

    await supabase.from('lab_manual_cakes')
      .update({ matched_order_ref: orderRef, matched_at: new Date().toISOString(), needs_odoo: false })
      .eq('id', manualCakeId);

    revalidatePath('/birthday-cakes');
    revalidatePath('/exceptional-orders');
    return { ok: true };
  }

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

  // Create the production card for that order's line(s), which the pipeline skipped. Goes
  // through upsertProductionCard (shared with odoo-apply.ts) so a repeated call for the SAME
  // order_ref — a double-click, or a second click before the page has refreshed and hidden the
  // button — grows the existing card instead of inserting a fresh duplicate. Before this fix,
  // this block did a blind `.insert(rows)` with no existence check first: exactly what produced
  // the 2026-08-07 finger-cake duplicate cards (Matcha/Pineapple Coconut/etc. — up to 4 cards
  // for one product, fixed retroactively in the data after the fact). See [[lab-app-audit-2026-08-07]].
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
  const { upsertProductionCard } = await import('@/lib/odoo-apply');
  // Sequential, not Promise.all — upsertProductionCard reads-then-writes the card, so two lines
  // that resolve to the SAME card (same import/team/variant/product) must run one after another
  // to accumulate correctly instead of racing on the same read.
  for (const l of oLines) {
    const v = l.product_sku ? vBySku[l.product_sku] : null; if (!v) continue;
    const f = fById[v.fiche_id]; const team = (f?.teams ?? [])[0] ?? '';
    if (!TEAMS4.includes(team)) continue;
    if (!l.qty || l.qty <= 0) continue;
    const variantLabel = v.label ?? l.variant_label ?? 'Standard';
    const bEntry = { shop_name: l.shop_name, order_ref: orderRef, qty: l.qty, delivery_time: l.delivery_time ?? null };
    // Best-effort: a card-write failure here shouldn't block the rejection itself (the refusal
    // is already recorded above, and re-clicking "Not this one" is harmless now that this path
    // is upsert-safe) — same non-fatal posture the rest of this file already uses.
    await upsertProductionCard(supabase, {
      importId: l.import_id, team, ficheId: v.fiche_id, variantId: v.id,
      name: l.product_name_vi, nameEn: f?.name_en ?? '', image: v.image_url ?? f?.image_url ?? null,
      variantLabel, qty: l.qty, bEntry,
    });
  }

  revalidatePath('/birthday-cakes');
  revalidatePath('/exceptional-orders');
  return { ok: true };
}

// Delete a manual cake (and its production card). Only for orders NOT yet linked to
// Odoo — once matched_order_ref is set, the Odoo side must be cancelled too, so callers
// must use cancelMatchedCakeAction instead (guarded here even if the UI already hides
// the delete button for matched orders — never trust the client alone).
export async function deleteManualCakeAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const { data: cake } = await supabase.from('lab_manual_cakes').select('assignment_id, matched_order_ref').eq('id', id).maybeSingle();
  if (cake?.matched_order_ref) return { error: 'Already linked to an Odoo order — cancel it instead of deleting' };
  if (cake?.assignment_id) await supabase.from('lab_assignments').delete().eq('id', cake.assignment_id);
  const { error } = await supabase.from('lab_manual_cakes').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/birthday-cakes');
  revalidatePath('/exceptional-orders');
  return { ok: true };
}

// Cancel a manual cake AFTER its Odoo order/replenishment was created (scenario 5/6 of the
// 2026-07-31 audit). Cancels just this cake's line in Odoo (never the whole document unless
// it was the last active line), and only THEN propagates locally: the manual cake's own
// production card (assignment_id) is marked cancelled — kept visible/struck through, produced
// qty preserved, exactly like the existing sync-driven cancellation in odoo-apply.ts. If the
// Odoo call fails, nothing local changes — we never want the app to say "cancelled" while
// Odoo still expects the cake.
export async function cancelMatchedCakeAction(manualCakeId: string, reason: string | null): Promise<{ ok?: boolean; warning?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const { data: mc } = await supabase.from('lab_manual_cakes')
    .select('id, matched_order_ref, cancelled_at, shop_name, product_sku, assignment_id').eq('id', manualCakeId).maybeSingle();
  if (!mc) return { error: 'Cake not found' };
  if (mc.cancelled_at) return { ok: true }; // already cancelled — idempotent
  if (!mc.matched_order_ref) return { error: 'Not linked to Odoo yet — delete it instead' };
  if (!mc.shop_name || !mc.product_sku) return { error: 'Missing shop or SKU — cannot resolve the Odoo line' };

  const { cancelOdooOrderLine } = await import('@/lib/odoo-shop-order-sync');
  const res = await cancelOdooOrderLine(mc.shop_name, mc.matched_order_ref, mc.product_sku);
  if (!res.ok) return { error: res.error ?? 'Odoo cancellation failed' };

  const now = new Date().toISOString();
  await supabase.from('lab_manual_cakes').update({
    cancelled_at: now, cancelled_by: session.user.id, cancelled_by_name: profile?.full_name ?? null,
    cancel_reason: reason, needs_odoo: false,
  }).eq('id', manualCakeId);

  if (mc.assignment_id) {
    const { data: asg } = await supabase.from('lab_assignments').select('notes').eq('id', mc.assignment_id).maybeSingle();
    const stamp = now.slice(5, 16).replace('T', ' ');
    const note = `⚠ Annulée par ${profile?.full_name ?? 'admin'} (Odoo ${stamp})${reason ? `: ${reason}` : ''}`;
    await supabase.from('lab_assignments').update({
      cancelled: true, total_qty: 0, qty_to_produce: 0,
      notes: asg?.notes ? `${asg.notes}\n${note}` : note,
      updated_at: now,
    }).eq('id', mc.assignment_id);
  }

  revalidatePath('/birthday-cakes');
  revalidatePath('/exceptional-orders');
  return { ok: true, warning: res.warning };
}
