'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { rawService } from '@/lib/raw-materials-db';
import { ensureSessionCountLine, tryCancelInventoryLine, tryRemoveCountLine, moveSessionCutoff, labCutoffFor, applyInventoryLines, type InventoryLineResult } from '@/lib/odoo-inventory';

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

  // First time this SKU is entered in this session → add it to the session's ONE consolidated
  // Odoo adjustment (opened by the first SKU, T0 = labCutoffFor(inventory_date) — see
  // odoo-inventory.ts, Axel 2026-10-12). A later correction of the same line (typo fix) never
  // touches Odoo's cut-off, so this only runs once per (session, sku).
  const { data: existing } = await supabase.from('lab_inventory_lines')
    .select('id, odoo_inventory_id, odoo_count_line_id, qty_theoretical')
    .eq('session_id', sessionId).eq('sku', line.sku).maybeSingle();

  let odooFields: { odoo_inventory_id?: number | null; odoo_count_line_id?: number | null; qty_theoretical?: number | null } = {};
  if (!existing?.odoo_count_line_id) {
    const { data: sess } = await supabase.from('lab_inventory_sessions')
      .select('inventory_date, status, odoo_inventory_id, odoo_cutoff_at').eq('id', sessionId).maybeSingle();
    if (!sess) return { error: 'Session introuvable' };
    if (sess.status !== 'draft') return { error: 'Phiên kiểm kê đã gửi / Session already submitted' };
    const cutoff = sess.odoo_cutoff_at ? new Date(sess.odoo_cutoff_at) : labCutoffFor(sess.inventory_date);
    let started = await ensureSessionCountLine({ sku: line.sku, sessionInventoryId: sess.odoo_inventory_id ?? null, inventoryDate: sess.inventory_date, cutoff });
    if (started.ok && started.createdInventory) {
      // claim the adjustment for this session; if another line won the race, drop ours and join theirs
      const { data: claimed } = await supabase.from('lab_inventory_sessions')
        .update({ odoo_inventory_id: started.odooInventoryId, odoo_cutoff_at: started.cutoffIso, updated_at: new Date().toISOString() })
        .eq('id', sessionId).is('odoo_inventory_id', null).select('id');
      if (!claimed?.length) {
        if (started.odooInventoryId) await tryCancelInventoryLine(started.odooInventoryId);
        const { data: won } = await supabase.from('lab_inventory_sessions')
          .select('odoo_inventory_id, odoo_cutoff_at').eq('id', sessionId).maybeSingle();
        started = await ensureSessionCountLine({
          sku: line.sku, sessionInventoryId: won?.odoo_inventory_id ?? null, inventoryDate: sess.inventory_date,
          cutoff: won?.odoo_cutoff_at ? new Date(won.odoo_cutoff_at) : cutoff,
        });
      }
    }
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
  const { data: line } = await supabase.from('lab_inventory_lines').select('session_id, odoo_inventory_id, odoo_count_line_id').eq('id', lineId).maybeSingle();
  const { data: sess } = line ? await supabase.from('lab_inventory_sessions').select('odoo_inventory_id').eq('id', line.session_id).maybeSingle() : { data: null as any };
  const { error } = await supabase.from('lab_inventory_lines').delete().eq('id', lineId);
  if (error) return { error: error.message };
  // Best-effort — never blocks the delete on this.
  if (line?.odoo_inventory_id && sess?.odoo_inventory_id === line.odoo_inventory_id) {
    // consolidated session adjustment (2026-10-12): remove only this product's line
    if (line.odoo_count_line_id) await tryRemoveCountLine(line.odoo_count_line_id);
  } else if (line?.odoo_inventory_id) {
    // legacy per-SKU adjustment (sessions started before 2026-10-12)
    await tryCancelInventoryLine(line.odoo_inventory_id);
  }
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

  const db = rawService();
  if (db) {
    const { count: open } = await db.from('lab_stock_count_unknowns').select('*', { count: 'exact', head: true }).eq('session_id', sessionId).eq('status', 'open');
    if (open) return { error: `Còn ${open} ảnh cần xác định / Encore ${open} photo(s) à identifier` };
  }

  const { data: lines, error } = await supabase.from('lab_inventory_lines')
    .select('id, sku, qty_counted, odoo_count_line_id, qty_theoretical').eq('session_id', sessionId);
  if (error) return { error: error.message };
  if (!lines?.length) return { error: 'Aucun produit compté' };

  const withLine = lines.filter(l => l.odoo_count_line_id);
  const missing = lines.filter(l => !l.odoo_count_line_id);

  // Date changed on the recap after counting started → move the consolidated adjustment's T0 to
  // the new date and recompute every line's system quantity at that cut-off before applying.
  const { data: sess } = await supabase.from('lab_inventory_sessions')
    .select('inventory_date, odoo_inventory_id').eq('id', sessionId).maybeSingle();
  if (sess?.odoo_inventory_id && inventoryDate && inventoryDate !== sess.inventory_date) {
    try {
      const cutoff = labCutoffFor(inventoryDate);
      const theoByLine = await moveSessionCutoff(sess.odoo_inventory_id, inventoryDate, cutoff);
      await supabase.from('lab_inventory_sessions').update({ inventory_date: inventoryDate, odoo_cutoff_at: cutoff.toISOString(), updated_at: new Date().toISOString() }).eq('id', sessionId);
      await Promise.all(withLine.filter(l => l.odoo_count_line_id && theoByLine[l.odoo_count_line_id as number] !== undefined).map(l =>
        supabase.from('lab_inventory_lines').update({ qty_theoretical: theoByLine[l.odoo_count_line_id as number] }).eq('id', l.id)));
    } catch (e: any) {
      return { error: `Không đổi được ngày cut-off trên Odoo / Could not move the cut-off: ${String(e?.message ?? e)}` };
    }
  }

  const res = withLine.length
    // Counted quantities only — the stock is not touched (Axel, 2026-10-31: every inventory lands in
    // Odoo as an open count sheet that he checks, adjusts and applies himself).
    ? await applyInventoryLines(withLine.map(l => ({ odooCountLineId: l.odoo_count_line_id as number, qtyCounted: Number(l.qty_counted) })), { applyToStock: false })
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

// ---- "Không thấy" on the finished goods (Axel, 2026-11-11): photo + quantity + unit + a word; the
// assistant puts the SKU on it in the recap, its quantity is added to that product's line. ----------
export type FgUnknown = {
  id: string; photoUrl: string | null; qty: number | null; unit: string | null; note: string | null;
  createdBy: string | null; createdAt: string; status: string; resolvedSku: string | null;
};
const mapFg = (u: any): FgUnknown => ({ id: u.id, photoUrl: u.photo_url, qty: u.qty == null ? null : Number(u.qty), unit: u.unit, note: u.note,
  createdBy: u.created_by_name, createdAt: u.created_at, status: u.status, resolvedSku: u.resolved_sku ?? null });

export async function listFgUnknownsAction(sessionId: string): Promise<{ unknowns?: FgUnknown[]; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data } = await db.from('lab_stock_count_unknowns').select('*').eq('session_id', sessionId).order('created_at');
  return { unknowns: (data ?? []).map(mapFg) };
}

export async function addFgUnknownAction(form: FormData): Promise<{ unknown?: FgUnknown; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const sessionId = String(form.get('sessionId') ?? '');
  const { data: sess } = await db.from('lab_inventory_sessions').select('status').eq('id', sessionId).maybeSingle();
  if (!sess || sess.status !== 'draft') return { error: 'Not found' };
  const qtyRaw = String(form.get('qty') ?? '').replace(',', '.');
  const qty = qtyRaw ? Number(qtyRaw) : null;
  if (qty != null && (!Number.isFinite(qty) || qty < 0)) return { error: 'Số lượng không hợp lệ / Quantité invalide' };
  const file = form.get('file');
  let path: string | null = null, url: string | null = null;
  if (file instanceof Blob && file.size > 0) {
    if (file.size > 8_000_000) return { error: 'Ảnh quá lớn / Photo trop lourde' };
    path = `inventory/unknown/fg-${sessionId}/${Date.now()}.jpg`;
    const { error } = await db.storage.from('lab-images').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: 'image/jpeg', upsert: true });
    if (error) return { error: error.message };
    url = db.storage.from('lab-images').getPublicUrl(path).data.publicUrl;
  }
  const note = String(form.get('note') ?? '').slice(0, 200) || null;
  if (!path && !note) return { error: 'Chụp ảnh hoặc ghi chú / Photo ou un mot requis' };
  const { data: u, error } = await db.from('lab_stock_count_unknowns').insert({
    session_id: sessionId, photo_path: path, photo_url: url, qty, unit: String(form.get('unit') ?? '') || null, note,
    created_by_name: auth.profile?.full_name ?? null,
  }).select('*').single();
  if (error || !u) return { error: error?.message ?? 'Insert failed' };
  return { unknown: mapFg(u) };
}

export async function resolveFgUnknownAction(unknownId: string, v: {
  status: 'matched' | 'ignored';
  product?: { fiche_id: string | null; variant_id: string | null; sku: string; product_name_vi: string; product_name_en: string | null; category: string | null };
  qty?: number;
}): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data: u } = await db.from('lab_stock_count_unknowns').select('*').eq('id', unknownId).maybeSingle();
  if (!u || !u.session_id) return { error: 'Not found' };
  if (u.status !== 'open') return { error: 'Đã xử lý / Déjà traité' };
  if (v.status === 'matched') {
    if (!v.product?.sku || v.qty == null || !Number.isFinite(v.qty) || v.qty < 0) return { error: 'Chọn sản phẩm và số lượng / Produit et quantité requis' };
    const { data: line } = await supabase.from('lab_inventory_lines').select('qty_counted').eq('session_id', u.session_id).eq('sku', v.product.sku).maybeSingle();
    const res = await saveLineAction(u.session_id, { ...v.product, qty_counted: Number(line?.qty_counted ?? 0) + v.qty });
    if (res.error) return { error: res.error };
  }
  await db.from('lab_stock_count_unknowns').update({ status: v.status, resolved_sku: v.product?.sku ?? null, resolved_qty: v.qty ?? null,
    resolved_by_name: auth.profile?.full_name ?? null, resolved_at: new Date().toISOString() }).eq('id', unknownId);
  return { ok: true };
}
