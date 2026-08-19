'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { previewInventoryPush, applyInventoryPush, type InventoryLineResult } from '@/lib/odoo-inventory';

async function requireProfile(supabase: ReturnType<typeof createClient>) {
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' as const };
  return { session, profile };
}

export async function getOrCreateSessionAction(inventoryDate: string): Promise<{ id?: string; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: existing } = await supabase.from('lab_inventory_sessions')
    .select('id').eq('inventory_date', inventoryDate).eq('status', 'draft').maybeSingle();
  if (existing) return { id: existing.id };

  const { data: created, error } = await supabase.from('lab_inventory_sessions').insert({
    inventory_date: inventoryDate,
    created_by: auth.session.user.id,
    created_by_name: auth.profile?.full_name ?? null,
  }).select('id').single();
  if (error) return { error: error.message };
  revalidatePath('/inventory');
  return { id: created.id };
}

// Product search for the "autre produit" escape hatch reuses the existing
// /api/lab/products-search route (same one the station "extra product" modal uses) —
// called directly from the client component, no need to duplicate the query here.

export async function saveLineAction(
  sessionId: string,
  line: { fiche_id: string | null; variant_id: string | null; sku: string; product_name_vi: string; product_name_en: string | null; category: string | null; qty_counted: number },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { error } = await supabase.from('lab_inventory_lines').upsert({
    session_id: sessionId,
    fiche_id: line.fiche_id,
    variant_id: line.variant_id,
    sku: line.sku,
    product_name_vi: line.product_name_vi,
    product_name_en: line.product_name_en,
    category: line.category,
    qty_counted: line.qty_counted,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'session_id,sku' });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteLineAction(lineId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const { error } = await supabase.from('lab_inventory_lines').delete().eq('id', lineId);
  if (error) return { error: error.message };
  return { ok: true };
}

export interface InventoryPreviewResponse {
  ok?: boolean; error?: string; lines?: InventoryLineResult[];
}

export async function previewSubmitAction(sessionId: string): Promise<InventoryPreviewResponse> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: lines, error } = await supabase.from('lab_inventory_lines')
    .select('sku, qty_counted').eq('session_id', sessionId);
  if (error) return { error: error.message };
  if (!lines?.length) return { error: 'Aucun produit compté' };

  const res = await previewInventoryPush(lines.map(l => ({ sku: l.sku, qtyCounted: Number(l.qty_counted) })));
  if (!res.ok) return { error: res.error };
  return { ok: true, lines: res.lines };
}

export interface InventorySubmitResponse {
  ok?: boolean; error?: string; lines?: InventoryLineResult[];
}

export async function confirmSubmitAction(sessionId: string, inventoryDate: string): Promise<InventorySubmitResponse> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: lines, error } = await supabase.from('lab_inventory_lines')
    .select('id, sku, qty_counted').eq('session_id', sessionId);
  if (error) return { error: error.message };
  if (!lines?.length) return { error: 'Aucun produit compté' };

  const res = await applyInventoryPush(lines.map(l => ({ sku: l.sku, qtyCounted: Number(l.qty_counted) })), inventoryDate);
  if (!res.ok) {
    await supabase.from('lab_inventory_sessions').update({
      odoo_push_status: 'error', odoo_push_error: res.error ?? 'Erreur inconnue', updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    return { error: res.error };
  }

  const bySku: Record<string, InventoryLineResult> = {};
  for (const r of res.lines) bySku[r.sku] = r;
  await Promise.all(lines.map(l => {
    const r = bySku[l.sku];
    if (!r) return Promise.resolve();
    return supabase.from('lab_inventory_lines').update({
      qty_system: r.qtySystem, odoo_push_status: r.ok ? 'success' : 'error', odoo_push_error: r.error ?? null,
      updated_at: new Date().toISOString(),
    }).eq('id', l.id);
  }));

  const errorCount = res.lines.filter(r => !r.ok).length;
  const pushStatus = errorCount === 0 ? 'success' : errorCount === res.lines.length ? 'error' : 'partial';
  await supabase.from('lab_inventory_sessions').update({
    inventory_date: inventoryDate,
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    submitted_by: auth.session.user.id,
    submitted_by_name: auth.profile?.full_name ?? null,
    odoo_push_status: pushStatus,
    odoo_push_error: errorCount ? `${errorCount} ligne(s) en erreur` : null,
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);

  revalidatePath('/inventory');
  revalidatePath(`/inventory/${sessionId}`);
  return { ok: true, lines: res.lines };
}
