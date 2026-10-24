import type { SupabaseClient } from '@supabase/supabase-js';
import { getScrapReasonTags, resolveProductsBySku, explainMissingSku, createLabScrap } from '@/lib/odoo-scrap';

// ONE way to record a Lab loss (Axel, 2026-10-24): the "Hao hụt Lab" tab and the delivery check
// ("Bánh bị hỏng / vỡ") both go through recordLabLoss, so the loss lands in the same table with
// the same Odoo scrap, and the source shows where it was declared. Best-effort Odoo: the local
// row is always written, an Odoo failure is kept on the row (odoo_sync_error) for follow-up.

export type LossReasonKind = 'broken' | 'expired' | 'test';

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
          ? `Lab scrap ${new Date().toISOString().slice(0, 10)} · delivery check ${input.orderRef ?? ''}`.trim()
          : `Lab scrap ${new Date().toISOString().slice(0, 10)}`;
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
