'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { sendZaloWebhook } from '@/lib/zalo';
import { TEAM_LABELS } from '@/lib/types';
import { getManualCakeCoverage, excessQty } from '@/lib/manual-cake-coverage';

export async function publishImportAction(
  importId: string,
  date: string,
): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''))
    return { error: 'Not authorized' };

  const { error: updateError } = await supabase
    .from('lab_imports')
    .update({
      status: 'published', published_at: new Date().toISOString(),
      published_by: session.user.id, published_by_name: profile?.full_name ?? null,
    })
    .eq('id', importId);
  if (updateError) return { error: updateError.message };

  // Whole-import publish = publish ALL its client orders (per-order publishing is the
  // default now; this button is the "publish everything" shortcut).
  await supabase.from('lab_order_lines')
    .update({ published: true, published_at: new Date().toISOString(), published_by: session.user.id, published_by_name: profile?.full_name ?? null })
    .eq('import_id', importId).eq('published', false);

  // Notifications — best-effort
  const { data: imp } = await supabase
    .from('lab_imports').select('type, order_number').eq('id', importId).single();
  const { data: asgns } = await supabase
    .from('lab_assignments').select('team').eq('import_id', importId);
  const teams = Array.from(new Set((asgns ?? []).map((a: any) => a.team as string)));
  const { data: settings } = await supabase
    .from('lab_notification_settings')
    .select('target, zalo_webhook_url').in('target', teams);

  const dateStr = new Date(date + 'T00:00:00').toLocaleDateString('vi-VN', {
    weekday: 'long', day: 'numeric', month: 'numeric',
  });
  const orderLabel = imp?.type === 'daily' ? 'Đơn chính' : 'Đơn khẩn';

  for (const s of settings ?? []) {
    if (!s.zalo_webhook_url) continue;
    const count = (asgns ?? []).filter((a: any) => a.team === s.target).length;
    const teamLabel = (TEAM_LABELS as any)[s.target]?.vi ?? s.target;
    const msg = `🍰 La Parisienne Lab\n📋 ${orderLabel} #${imp?.order_number} — ${dateStr}\n✅ Đã phát hành cho ${teamLabel}: ${count} sản phẩm cần sản xuất`;
    await sendZaloWebhook(s.zalo_webhook_url, msg);
  }

  revalidatePath(`/orders/${date}`);
  return {};
}

// Publish a SINGLE client order (order_ref) of a day. Its production shows up for the chefs
// (their card quantities reflect only published orders — see filterByPublished). The import
// is flagged published as soon as one of its orders is. Read-only towards Odoo.
export async function publishOrderAction(orderRef: string, date: string): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase
    .from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''))
    return { error: 'Not authorized' };

  const { data: lines, error: selErr } = await supabase
    .from('lab_order_lines').select('import_id').eq('order_ref', orderRef).eq('delivery_date', date);
  if (selErr) return { error: selErr.message };
  const importIds = Array.from(new Set((lines ?? []).map((l: any) => l.import_id)));
  if (!importIds.length) return { error: 'Order not found' };

  const { error: upErr } = await supabase.from('lab_order_lines')
    .update({ published: true, published_at: new Date().toISOString(), published_by: session.user.id, published_by_name: profile?.full_name ?? null })
    .eq('order_ref', orderRef).eq('delivery_date', date).eq('published', false);
  if (upErr) return { error: upErr.message };

  // Flag the parent import(s) published (first time only, to record who/when)
  await supabase.from('lab_imports')
    .update({ status: 'published', published_at: new Date().toISOString(), published_by: session.user.id, published_by_name: profile?.full_name ?? null })
    .in('id', importIds).neq('status', 'published');

  revalidatePath(`/orders/${date}`);
  return {};
}

// Un-publish a single client order — removes its production from the chefs (their card
// quantities drop back). If the import has no published order left, it returns to draft.
export async function unpublishOrderAction(orderRef: string, date: string): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''))
    return { error: 'Not authorized' };

  const { data: lines } = await supabase
    .from('lab_order_lines').select('import_id').eq('order_ref', orderRef).eq('delivery_date', date);
  const importIds = Array.from(new Set((lines ?? []).map((l: any) => l.import_id)));

  const { error: upErr } = await supabase.from('lab_order_lines')
    .update({ published: false, published_at: null, published_by: null, published_by_name: null })
    .eq('order_ref', orderRef).eq('delivery_date', date);
  if (upErr) return { error: upErr.message };

  // Any import that no longer has a published order goes back to draft
  for (const importId of importIds) {
    const { count } = await supabase.from('lab_order_lines')
      .select('*', { count: 'exact', head: true }).eq('import_id', importId).eq('published', true);
    if (!count) await supabase.from('lab_imports').update({ status: 'draft' }).eq('id', importId);
  }

  revalidatePath(`/orders/${date}`);
  return {};
}

// Create production cards for order lines that now have a recipe card but had none
// when the import was published (e.g. a fiche was added afterwards). Scans all
// published imports for the date and backfills any missing assignment.
export async function generateMissingCardsAction(
  date: string,
): Promise<{ created?: number; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''))
    return { error: 'Not authorized' };

  const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

  const { data: imports } = await supabase
    .from('lab_imports').select('id').eq('delivery_date', date).eq('status', 'published');
  const importIds = (imports ?? []).map((i: any) => i.id);
  if (!importIds.length) return { created: 0 };

  const { data: orderLines } = await supabase
    .from('lab_order_lines')
    .select('import_id, order_ref, shop_name, product_sku, product_name_vi, variant_label, qty, delivery_time')
    .in('import_id', importIds);
  if (!orderLines?.length) return { created: 0 };

  // Resolve SKU → variant → fiche (team, name_en, image)
  const skus = Array.from(new Set(orderLines.map(l => l.product_sku).filter(Boolean)));
  const { data: variants } = await supabase
    .from('lab_fiche_variants').select('id, sku, label, fiche_id, image_url').in('sku', skus);
  const vBySku: Record<string, any> = {};
  for (const v of variants ?? []) if (v.sku) vBySku[v.sku] = v;
  const ficheIds = Array.from(new Set((variants ?? []).map(v => v.fiche_id).filter(Boolean)));
  const { data: fiches } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, name_en, image_url, teams').in('id', ficheIds)
    : { data: [] as any[] };
  const fById: Record<string, any> = {};
  for (const f of fiches ?? []) fById[f.id] = f;

  // Existing assignments — need the breakdown, not just presence: a card may already exist but
  // only cover PART of a line's demand (the sync creates "excess-only" cards for products also
  // covered by a matched manual cake — see manual-cake-coverage.ts). Matched by team+variant+
  // name+order_ref, NOT scoped to one import_id, so a card living under a different (e.g. a
  // legacy same-day-merged) import still counts as coverage instead of causing a duplicate.
  const { data: existing } = await supabase
    .from('lab_assignments').select('import_id, team, variant_label, product_name_vi, breakdown, cancelled').in('import_id', importIds);
  const coveredByBreakdown = new Map<string, number>();
  for (const a of existing ?? []) {
    if (a.cancelled) continue;
    for (const b of Array.isArray(a.breakdown) ? a.breakdown : []) {
      if (!b?.order_ref) continue;
      const k = `${a.team}||${a.variant_label}||${a.product_name_vi}||${b.order_ref}`;
      coveredByBreakdown.set(k, (coveredByBreakdown.get(k) ?? 0) + (b.qty ?? 0));
    }
  }

  // Manual-cake coverage for this date (unmatched → whole SKU excluded; matched → capped at the
  // cake's own qty, per order_ref — see manual-cake-coverage.ts).
  const coverage = await getManualCakeCoverage(supabase, date);

  // Group order lines that now resolve to a fiche/team, per import+team+variant+name — only the
  // portion of each line NOT already covered (by a manual cake, and/or by an existing card).
  type Group = { import_id: string; team: string; variant_label: string; name: string;
    fiche_id: string; variant_id: string; name_en: string; image_url: string | null;
    total: number; breakdown: any[] };
  const groups = new Map<string, Group>();
  for (const l of orderLines) {
    const v = l.product_sku ? vBySku[l.product_sku] : null;
    if (!v) continue;                       // still no fiche → skip
    const f = fById[v.fiche_id];
    const team = (f?.teams ?? [])[0] ?? '';
    if (!TEAMS.includes(team)) continue;    // no assignable team
    const variantLabel = v.label ?? l.variant_label ?? 'Standard';
    const needed = (l.order_ref && l.product_sku)
      ? excessQty(coverage, l.order_ref, l.product_sku, date, l.qty ?? 0, l.shop_name)
      : (l.qty ?? 0);
    if (needed <= 0) continue;              // fully covered by a manual cake
    const tracked = l.order_ref ? (coveredByBreakdown.get(`${team}||${variantLabel}||${l.product_name_vi}||${l.order_ref}`) ?? 0) : 0;
    const gap = needed - tracked;
    if (gap <= 0) continue;                 // an existing card already covers this order's demand
    const key = `${l.import_id}||${team}||${variantLabel}||${l.product_name_vi}`;
    let g = groups.get(key);
    if (!g) {
      g = { import_id: l.import_id, team, variant_label: variantLabel, name: l.product_name_vi,
        fiche_id: v.fiche_id, variant_id: v.id, name_en: f?.name_en ?? '',
        image_url: v.image_url ?? f?.image_url ?? null, total: 0, breakdown: [] };
      groups.set(key, g);
    }
    g.total += gap;
    g.breakdown.push({ shop_name: l.shop_name, order_ref: l.order_ref, qty: gap, delivery_time: l.delivery_time ?? null });
  }

  const toInsert = Array.from(groups.values()).filter(g => g.total > 0).map((g, idx) => ({
    import_id: g.import_id, team: g.team, fiche_id: g.fiche_id, variant_id: g.variant_id,
    product_name_vi: g.name, product_name_en: g.name_en, image_url: g.image_url,
    variant_label: g.variant_label, total_qty: g.total, qty_to_produce: g.total, qty_produced: 0,
    status: 'pending', sort_order: 5000 + idx, breakdown: g.breakdown,
  }));
  if (!toInsert.length) return { created: 0 };

  const { error } = await supabase.from('lab_assignments').insert(toInsert);
  if (error) return { error: error.message };

  revalidatePath(`/orders/${date}`);
  return { created: toInsert.length };
}
