'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { ensureInventoryLineStarted, tryCancelInventoryLine, applyInventoryLines, type InventoryLineResult } from '@/lib/odoo-inventory';

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

  // First time this SKU is entered in this session → open (or reuse) its Odoo cut-off NOW,
  // not at final submit (see odoo-inventory.ts doc comment). A later correction of the same
  // line (typo fix) must NEVER re-freeze the cut-off, so this only runs once per (session, sku).
  const { data: existing } = await supabase.from('lab_inventory_lines')
    .select('id, odoo_inventory_id, odoo_count_line_id, qty_theoretical')
    .eq('session_id', sessionId).eq('sku', line.sku).maybeSingle();

  let odooFields: { odoo_inventory_id?: number | null; odoo_count_line_id?: number | null; qty_theoretical?: number | null } = {};
  if (!existing?.odoo_count_line_id) {
    const started = await ensureInventoryLineStarted(line.sku);
    if (!started.ok) return { error: started.error ?? 'Impossible d\'ouvrir le comptage sur Odoo' };
    odooFields = {
      odoo_inventory_id: started.odooInventoryId, odoo_count_line_id: started.odooCountLineId,
      qty_theoretical: started.qtyTheoretical,
    };
  }

  const { error } = await supabase.from('lab_inventory_lines').upsert({
    session_id: sessionId,
    fiche_id: line.fiche_id,
    variant_id: line.variant_id,
    sku: line.sku,
    product_name_vi: line.product_name_vi,
    product_name_en: line.product_name_en,
    category: line.category,
    qty_counted: line.qty_counted,
    ...odooFields,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'session_id,sku' });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteLineAction(lineId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const { data: line } = await supabase.from('lab_inventory_lines').select('odoo_inventory_id').eq('id', lineId).maybeSingle();
  const { error } = await supabase.from('lab_inventory_lines').delete().eq('id', lineId);
  if (error) return { error: error.message };
  // Best-effort — never blocks the delete on this (see tryCancelInventoryLine's doc comment).
  if (line?.odoo_inventory_id) await tryCancelInventoryLine(line.odoo_inventory_id);
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
    .select('sku, qty_counted, qty_theoretical, odoo_count_line_id').eq('session_id', sessionId);
  if (error) return { error: error.message };
  if (!lines?.length) return { error: 'Aucun produit compté' };

  // Purely local — the theoretical qty was already frozen on Odoo when each line was first
  // entered (saveLineAction), so the recap needs no extra Odoo round-trip: it's just the stored
  // cut-off vs. the counted number.
  const previewLines: InventoryLineResult[] = lines.map(l => {
    if (!l.odoo_count_line_id) {
      return { sku: l.sku, found: false, qtySystem: null, qtyCounted: Number(l.qty_counted), diff: null, ok: false, error: 'Comptage jamais ouvert sur Odoo — réessayer de saisir cette ligne' };
    }
    const theo = Number(l.qty_theoretical ?? 0);
    return { sku: l.sku, found: true, qtySystem: theo, qtyCounted: Number(l.qty_counted), diff: Number(l.qty_counted) - theo, ok: true };
  });
  return { ok: true, lines: previewLines };
}

export interface InventorySubmitResponse {
  ok?: boolean; error?: string; lines?: InventoryLineResult[];
}

export async function confirmSubmitAction(sessionId: string, inventoryDate: string): Promise<InventorySubmitResponse> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: lines, error } = await supabase.from('lab_inventory_lines')
    .select('id, sku, qty_counted, odoo_count_line_id, qty_theoretical').eq('session_id', sessionId);
  if (error) return { error: error.message };
  if (!lines?.length) return { error: 'Aucun produit compté' };

  const withLine = lines.filter(l => l.odoo_count_line_id);
  const missing = lines.filter(l => !l.odoo_count_line_id);

  const res = withLine.length
    ? await applyInventoryLines(withLine.map(l => ({ odooCountLineId: l.odoo_count_line_id as number, qtyCounted: Number(l.qty_counted) })))
    : { ok: true, lines: [] as (InventoryLineResult & { odooCountLineId: number })[] };
  if (!res.ok) {
    await supabase.from('lab_inventory_sessions').update({
      odoo_push_status: 'error', odoo_push_error: res.error ?? 'Erreur inconnue', updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    return { error: res.error };
  }

  const byLineId: Record<number, InventoryLineResult> = {};
  for (const r of res.lines) byLineId[(r as any).odooCountLineId] = r;
  await Promise.all(withLine.map(l => {
    const r = byLineId[l.odoo_count_line_id as number];
    if (!r) return Promise.resolve();
    return supabase.from('lab_inventory_lines').update({
      qty_system: r.qtySystem, odoo_push_status: r.ok ? 'success' : 'error', odoo_push_error: r.error ?? null,
      updated_at: new Date().toISOString(),
    }).eq('id', l.id);
  }));
  await Promise.all(missing.map(l =>
    supabase.from('lab_inventory_lines').update({
      odoo_push_status: 'error', odoo_push_error: 'Comptage jamais ouvert sur Odoo', updated_at: new Date().toISOString(),
    }).eq('id', l.id)
  ));
  const allResultLines: InventoryLineResult[] = [
    ...res.lines.map(r => ({ sku: withLine.find(l => l.odoo_count_line_id === (r as any).odooCountLineId)?.sku ?? r.sku, found: r.found, qtySystem: r.qtySystem, qtyCounted: r.qtyCounted, diff: r.diff, ok: r.ok, error: r.error })),
    ...missing.map(l => ({ sku: l.sku, found: false, qtySystem: null, qtyCounted: Number(l.qty_counted), diff: null, ok: false, error: 'Comptage jamais ouvert sur Odoo' })),
  ];

  const errorCount = allResultLines.filter(r => !r.ok).length;
  const pushStatus = errorCount === 0 ? 'success' : errorCount === allResultLines.length ? 'error' : 'partial';
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
  return { ok: true, lines: allResultLines };
}
