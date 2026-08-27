'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { getScrapReasonTags, resolveProductsBySku, createLabScrap } from '@/lib/odoo-scrap';

// LAB's own scrap/loss report — admin + assistant space (never the shop portal). Axel,
// 2026-08-27: "une fonction de scrap similaire aux shops mais pour les produits casse du lab".
// Same mechanism as shop/actions.ts's loss report (multi-item, best-effort Odoo sync, never
// blocks/discards the local report if Odoo fails), but scoped to LAB's own Odoo warehouse
// (odoo-scrap.ts's createLabScrap/resolveLabWarehouseLocation) and gated to logged-in staff
// instead of a shared shop account — reporter name comes straight from the caller's own profile,
// no name picker needed here (unlike the shop portal's shared-account model).

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function requireStaff(): Promise<{ id: string; name: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' };
  return { id: session.user.id, name: profile?.full_name ?? '' };
}

export type LabLossReason = { id: number; name: string };

// Same "reduce to casse/périmé" trim as the shop portal (Axel, 2026-08-25 request applies here
// too) — matched by keyword against however the tags are actually named in Odoo, with a
// full-list fallback if nothing matches.
function normalizeReasonName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const BROKEN_REASON_KEYWORDS = ['vo', 'hong', 'gay', 'be ', 'nut', 'casse', 'broken', 'damage'];
const EXPIRED_REASON_KEYWORDS = ['het han', 'han su dung', 'perime', 'expired', 'expiry', 'qua han'];
function reduceLossReasons(all: LabLossReason[]): LabLossReason[] {
  const filtered = all.filter(r => {
    const n = normalizeReasonName(r.name);
    return BROKEN_REASON_KEYWORDS.some(k => n.includes(k)) || EXPIRED_REASON_KEYWORDS.some(k => n.includes(k));
  });
  return filtered.length > 0 ? filtered : all;
}

export async function getLabLossReasonsAction(): Promise<{ reasons?: LabLossReason[]; error?: string }> {
  const auth = await requireStaff();
  if ('error' in auth) return { error: auth.error };
  try {
    return { reasons: reduceLossReasons(await getScrapReasonTags()) };
  } catch (e: any) {
    return { error: e?.message ?? 'Odoo unavailable' };
  }
}

export type LabLoss = {
  id: string; sku: string | null; productName: string; qty: number;
  reasonTagName: string; note: string | null; odooScrapId: number | null; odooSyncError: string | null;
  reportedByName: string; reportedAt: string;
};

export async function getLabLossesAction(): Promise<{ losses?: LabLoss[]; error?: string }> {
  const auth = await requireStaff();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_internal_losses')
    .select('id, sku, product_name, qty, reason_tag_name, note, odoo_scrap_id, odoo_sync_error, reported_by_name, reported_at')
    .order('reported_at', { ascending: false })
    .limit(50);
  if (error) return { error: error.message };
  return {
    losses: (data ?? []).map(r => ({
      id: r.id, sku: r.sku, productName: r.product_name, qty: Number(r.qty),
      reasonTagName: r.reason_tag_name, note: r.note, odooScrapId: r.odoo_scrap_id, odooSyncError: r.odoo_sync_error,
      reportedByName: r.reported_by_name, reportedAt: r.reported_at,
    })),
  };
}

export async function recordLabLossAction(input: {
  sku: string | null; productName: string; qty: number;
  reasonTagId: number; reasonTagName: string; note: string | null;
}): Promise<{ ok?: boolean; odooSynced?: boolean; odooError?: string; error?: string }> {
  const auth = await requireStaff();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const productName = (input.productName ?? '').trim().slice(0, 200);
  if (!productName) return { error: 'Product required' };
  const qty = Number(input.qty);
  if (!(qty > 0)) return { error: 'Quantity must be > 0' };
  if (!input.reasonTagId || !input.reasonTagName) return { error: 'Reason required' };

  // Best-effort Odoo sync — never blocks or discards the local report (same guarantee as the
  // shop portal's loss report).
  let odooScrapId: number | null = null;
  let odooSyncError: string | null = null;
  try {
    if (input.sku) {
      const products = await resolveProductsBySku([input.sku]);
      const product = products[input.sku];
      if (!product) {
        odooSyncError = `SKU "${input.sku}" introuvable sur Odoo`;
      } else {
        const result = await createLabScrap({
          productId: product.id,
          uomId: product.uom_id,
          qty,
          reasonTagIds: [input.reasonTagId],
          origin: `Lab scrap ${new Date().toISOString().slice(0, 10)}`,
        });
        if (result.ok) odooScrapId = result.scrapId ?? null;
        else odooSyncError = result.error ?? 'Odoo sync failed';
      }
    } else {
      odooSyncError = 'Pas de SKU — non synchronisé sur Odoo';
    }
  } catch (e: any) {
    odooSyncError = e?.message ?? 'Odoo sync failed';
  }

  const { error } = await supabase.from('lab_internal_losses').insert({
    sku: input.sku, product_name: productName, qty,
    reason_tag_id: input.reasonTagId, reason_tag_name: input.reasonTagName,
    note: input.note ? input.note.slice(0, 300) : null,
    odoo_scrap_id: odooScrapId, odoo_sync_error: odooSyncError,
    reported_by_name: auth.name || 'Staff', reported_by_id: auth.id,
    reported_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };
  return { ok: true, odooSynced: !!odooScrapId, odooError: odooSyncError ?? undefined };
}
