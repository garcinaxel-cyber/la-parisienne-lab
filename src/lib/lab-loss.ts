import type { SupabaseClient } from '@supabase/supabase-js';
import { getScrapReasonTags, resolveProductsBySku, explainMissingSku, createLabScrap } from '@/lib/odoo-scrap';

// ONE way to record a Lab loss (Axel, 2026-10-24): the "Hao hụt Lab" tab and the delivery check
// ("Bánh bị hỏng / vỡ") both go through recordLabLoss, so the loss lands in the same table with
// the same Odoo scrap, and the source shows where it was declared. Best-effort Odoo: the local
// row is always written, an Odoo failure is kept on the row (odoo_sync_error) for follow-up.

export type LossReasonKind = 'broken' | 'expired' | 'test';

const vnDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function norm(s: string): string { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
const BROKEN = ['vo', 'hong', 'gay', 'be ', 'nut', 'casse', 'broken', 'damage'];
const EXPIRED = ['het han', 'han su dung', 'perime', 'expired', 'expiry', 'qua han', 'het date'];
const TEST = ['test', 'hang thu'];

export async function lossReasonTags(): Promise<{ id: number; name: string; kind: LossReasonKind | null }[]> {
  const all = await getScrapReasonTags();
  return all.map(t => {
    const n = norm(t.name);
    const kind: LossReasonKind | null = BROKEN.some(k => n.includes(k)) ? 'broken'
      : EXPIRED.some(k => n.includes(k)) ? 'expired' : TEST.some(k => n.includes(k)) ? 'test' : null;
    return { ...t, kind };
  });
}

export async function brokenReasonTag(): Promise<{ id: number; name: string } | null> {
  try { return (await lossReasonTags()).find(t => t.kind === 'broken') ?? null; } catch { return null; }
}

export interface RecordLabLossInput {
  sku: string | null; productName: string; qty: number;
  reasonTagId: number; reasonTagName: string; note: string | null;
  reportedByName: string; reportedById: string | null;
  photoUrl?: string | null;
  source?: 'lab_scrap' | 'delivery_check';
  deliveryDate?: string | null; orderRef?: string | null; checkLineId?: string | null;
}

export async function recordLabLoss(supabase: SupabaseClient, input: RecordLabLossInput):
  Promise<{ ok?: boolean; id?: string; odooScrapId?: number | null; odooError?: string | null; error?: string }> {
  let odooScrapId: number | null = null;
  let odooSyncError: string | null = null;
  try {
    if (input.sku) {
      const products = await resolveProductsBySku([input.sku]);
      const product = products[input.sku];
      if (!product) odooSyncError = await explainMissingSku(input.sku);
      else {
        const origin = input.source === 'delivery_check'
          ? `Lab scrap ${vnDay()} · delivery check ${input.orderRef ?? ''}`.trim()
          : `Lab scrap ${vnDay()}`;
        const result = await createLabScrap({ productId: product.id, uomId: product.uom_id, qty: input.qty, reasonTagIds: [input.reasonTagId], origin });
        if (result.ok) odooScrapId = result.scrapId ?? null;
        else odooSyncError = result.error ?? 'Odoo sync failed';
      }
    } else odooSyncError = 'Pas de SKU — non synchronisé sur Odoo';
  } catch (e: any) {
    odooSyncError = e?.message ?? 'Odoo sync failed';
  }
  const { data, error } = await supabase.from('lab_internal_losses').insert({
    sku: input.sku, product_name: input.productName.slice(0, 200), qty: input.qty,
    reason_tag_id: input.reasonTagId, reason_tag_name: input.reasonTagName,
    note: input.note ? input.note.slice(0, 300) : null,
    odoo_scrap_id: odooScrapId, odoo_sync_error: odooSyncError,
    reported_by_name: input.reportedByName || 'Staff', reported_by_id: input.reportedById,
    reported_at: new Date().toISOString(),
    photo_url: input.photoUrl ?? null, source: input.source ?? 'lab_scrap',
    delivery_date: input.deliveryDate ?? null, order_ref: input.orderRef ?? null, check_line_id: input.checkLineId ?? null,
  }).select('id').single();
  if (error) return { error: error.message };
  return { ok: true, id: data?.id, odooScrapId, odooError: odooSyncError };
}

// Retry the Odoo scrap of a loss row whose first attempt failed (no odoo_scrap_id yet).
export async function retryLossScrap(supabase: SupabaseClient, lossId: string): Promise<{ ok: boolean; scrapId?: number; error?: string }> {
  const { data: r } = await supabase.from('lab_internal_losses').select('id, sku, qty, reason_tag_id, odoo_scrap_id, source, order_ref').eq('id', lossId).maybeSingle();
  if (!r) return { ok: false, error: 'Loss not found' };
  if (r.odoo_scrap_id) return { ok: true, scrapId: r.odoo_scrap_id };
  if (!r.sku) return { ok: false, error: 'No SKU' };
  try {
    const product = (await resolveProductsBySku([r.sku]))[r.sku];
    if (!product) return { ok: false, error: await explainMissingSku(r.sku) };
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const res = await createLabScrap({ productId: product.id, uomId: product.uom_id, qty: Number(r.qty), reasonTagIds: [r.reason_tag_id], origin: `Lab scrap ${day}${r.order_ref ? ` · delivery check ${r.order_ref}` : ''} (retry)` });
    if (!res.ok) { await supabase.from('lab_internal_losses').update({ odoo_sync_error: res.error ?? 'Odoo sync failed' }).eq('id', lossId); return { ok: false, error: res.error }; }
    await supabase.from('lab_internal_losses').update({ odoo_scrap_id: res.scrapId ?? null, odoo_sync_error: null }).eq('id', lossId);
    return { ok: true, scrapId: res.scrapId };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}
