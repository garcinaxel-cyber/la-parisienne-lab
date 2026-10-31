'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { applyOdooChanges } from '@/lib/odoo-apply';
import { revalidatePath } from 'next/cache';
import { odooExecute, odooConfigured } from '@/lib/odoo';

async function guard() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { supabase, ok: false };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  return { supabase, ok: ['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''), userId: session.user.id };
}

// Apply all pending Odoo modifications detected by the auto-sync, then mark them resolved.
export async function applyPendingChangesAction(): Promise<{ applied?: number; error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { data: pending } = await supabase
    .from('lab_odoo_changes').select('id, order_ref, cancelled, items, delivery_date').eq('status', 'pending');
  if (!pending?.length) return { applied: 0 };

  const { applied, errors } = await applyOdooChanges(supabase, pending.map((p: any) => ({
    order_ref: p.order_ref, cancelled: p.cancelled, items: p.items,
  })));
  await supabase.from('lab_odoo_changes')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .in('id', pending.map((p: any) => p.id));

  // Same silent-failure risk as the auto-sync path — surface any card-write failure instead
  // of letting it vanish once these rows flip to 'resolved'.
  if (errors.length) {
    const dateByRef = new Map((pending as any[]).map((p: any) => [p.order_ref, p.delivery_date]));
    const byOrder = new Map<string, { sku: string; name?: string; reason: string }[]>();
    for (const e of errors) {
      const arr = byOrder.get(e.order_ref) ?? [];
      arr.push({ sku: e.sku, name: e.name, reason: e.reason });
      byOrder.set(e.order_ref, arr);
    }
    await supabase.from('lab_odoo_changes').insert(Array.from(byOrder.entries()).map(([order_ref, items]) => ({
      order_ref, cancelled: false, items,
      delivery_date: dateByRef.get(order_ref) ?? null, status: 'error',
    })));
  }

  revalidatePath('/dashboard');
  return { applied: applied.length };
}

// Acknowledge sync-error alerts (production card write failures) once handled — e.g. after
// manually running "Generate missing cards" or fixing the underlying data.
export async function resolveSyncErrorsAction(): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  await supabase.from('lab_odoo_changes')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('status', 'error');
  revalidatePath('/dashboard');
  return {};
}

// Dismiss pending changes without applying (e.g. false positive)
export async function dismissPendingChangesAction(): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  await supabase.from('lab_odoo_changes')
    .update({ status: 'dismissed', resolved_at: new Date().toISOString() }).eq('status', 'pending');
  revalidatePath('/dashboard');
  return {};
}

// Permanently exclude a SKU from production (packaging, drinks…)
export async function excludeSkuAction(sku: string, name: string, reason?: string): Promise<{ error?: string }> {
  const { supabase, ok, userId } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus')
    .upsert({ sku, product_name: name, reason: reason ?? null, excluded_by: userId }, { onConflict: 'sku' });
  if (error) return { error: error.message };
  revalidatePath('/orders', 'layout');
  return {};
}

// From a "changed in Odoo" banner (dashboard/import): mark ONE sku as never-produced.
// Excludes it AND strips it from every pending change; a change with no items left is resolved.
export async function excludeChangeSkuAction(sku: string, name: string): Promise<{ error?: string }> {
  const { supabase, ok, userId } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus')
    .upsert({ sku, product_name: name, reason: 'packaging/not produced', excluded_by: userId }, { onConflict: 'sku' });
  if (error) return { error: error.message };

  const { data: pending } = await supabase
    .from('lab_odoo_changes').select('id, items').eq('status', 'pending');
  for (const row of pending ?? []) {
    const items = (row.items ?? []).filter((it: any) => it.sku !== sku);
    if (items.length === (row.items ?? []).length) continue; // this sku wasn't in the row
    if (items.length === 0) {
      await supabase.from('lab_odoo_changes')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', row.id);
    } else {
      await supabase.from('lab_odoo_changes').update({ items }).eq('id', row.id);
    }
  }
  revalidatePath('/dashboard');
  revalidatePath('/orders', 'layout');
  return {};
}

export async function unexcludeSkuAction(sku: string): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus').delete().eq('sku', sku);
  if (error) return { error: error.message };
  revalidatePath('/admin/excluded');
  return {};
}

// Photo for a non-production/packaging item (Axel, 2026-09-22: "laisse moi la possibilité de
// mettre une photo" — these items have no fiche/variant, so no lab_fiche_variants.image_url to
// piggyback on; same 'lab-images' storage bucket + upload pattern as FicheEditor, just its own
// column on lab_excluded_skus). Also read by shop/actions.ts's packaging branch of
// searchManagerOrderProductsAction so it shows up for shop managers ordering it, not just here.
export async function setExcludedSkuImageAction(sku: string, imageUrl: string): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus').update({ image_url: imageUrl || null }).eq('sku', sku);
  if (error) return { error: error.message };
  revalidatePath('/admin/excluded');
  return {};
}

// Show / hide a non-production item in the shops' order catalogue and stock-count search
// (Axel, 2026-10-31). Hidden items stay non-production (never a production card).
export async function setExcludedSkuShopVisibleAction(sku: string, visible: boolean): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus').update({ shop_visible: visible }).eq('sku', sku);
  if (error) return { error: error.message };
  revalidatePath('/admin/excluded');
  return {};
}

export type OdooCandidate = { sku: string; name: string; inList: boolean; isProduction: boolean; saleOk: boolean };

// Search Odoo products to add to the non-production list (Axel, 2026-10-31: "en rajouter depuis
// Odoo … ajout rapide"). One text query, or several codes pasted at once (space / comma / new
// line). Vietnamese names. Flags products already in the list and production SKUs (a recipe
// variant) — adding one of those would stop its production cards, so the UI asks first.
export async function searchOdooForExclusionAction(query: string): Promise<{ products?: OdooCandidate[]; error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  if (!odooConfigured()) return { error: 'Odoo not configured' };
  const raw = (query ?? '').trim().slice(0, 2000);
  if (raw.length < 2) return { products: [] };
  const tokens = raw.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
  const multi = tokens.length > 1 && tokens.every(t => /^[A-Za-z0-9.\-_]+$/.test(t) && /\d/.test(t));
  const domain: any[] = multi
    ? [['default_code', 'in', tokens]]
    : ['&', ['default_code', '!=', false], '|', ['name', 'ilike', raw], ['default_code', 'ilike', raw]];
  try {
    const rows = await odooExecute<any[]>('product.product', 'search_read', [domain],
      { fields: ['default_code', 'name', 'display_name', 'sale_ok'], context: { lang: 'vi_VN' }, limit: multi ? 200 : 30 });
    const skus = rows.map(r => r.default_code).filter(Boolean);
    const [{ data: ex }, { data: fv }] = await Promise.all([
      skus.length ? supabase.from('lab_excluded_skus').select('sku').in('sku', skus) : Promise.resolve({ data: [] as any[] }),
      skus.length ? supabase.from('lab_fiche_variants').select('sku').in('sku', skus) : Promise.resolve({ data: [] as any[] }),
    ]);
    const inList = new Set((ex ?? []).map((r: any) => r.sku));
    const prod = new Set((fv ?? []).map((r: any) => r.sku));
    const seen = new Set<string>();
    const products: OdooCandidate[] = [];
    for (const r of rows) {
      const sku = r.default_code as string;
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      const name = String(r.display_name || '').replace(/\[.*?\]\s*/, '').trim() || r.name || sku;
      products.push({ sku, name, inList: inList.has(sku), isProduction: prod.has(sku), saleOk: !!r.sale_ok });
    }
    return { products };
  } catch (e: any) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
}

// Add one or several Odoo products to the non-production list, visible to shops or not.
export async function addExcludedFromOdooAction(items: { sku: string; name: string }[], shopVisible: boolean): Promise<{ added?: number; error?: string }> {
  const { supabase, ok, userId } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const rows = (items ?? []).filter(i => i?.sku).slice(0, 200).map(i => ({
    sku: String(i.sku).trim(), product_name: String(i.name ?? '').trim().slice(0, 200) || null,
    reason: 'added from Odoo', excluded_by: userId, shop_visible: !!shopVisible,
  }));
  if (!rows.length) return { added: 0 };
  const { error } = await supabase.from('lab_excluded_skus').upsert(rows, { onConflict: 'sku', ignoreDuplicates: true });
  if (error) return { error: error.message };
  revalidatePath('/admin/excluded');
  revalidatePath('/orders', 'layout');
  return { added: rows.length };
}
