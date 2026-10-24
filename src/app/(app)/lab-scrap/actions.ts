'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { getScrapReasonTags } from '@/lib/odoo-scrap';
import { recordLabLoss } from '@/lib/lab-loss';
import { computeDayPool } from '@/lib/delivery-gap';
import { labDateOf } from '@/lib/odoo';

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
const EXPIRED_REASON_KEYWORDS = ['het han', 'han su dung', 'perime', 'expired', 'expiry', 'qua han', 'het date'];
// Axel, 2026-08-29: manager asked to add "Test" and "out of date" as reasons. Both already exist
// as real Odoo tags -- confirmed live via stock.scrap.reason.tag: id 9 "test" and id 6 "hết date"
// ("out of date", diacritics stripped by normalizeReasonName below to "het date" -- added above,
// doesn't match the existing "het han"/"qua han" expired phrasing so it fell through unseen).
// "test" alone was invisible too since it matches neither the broken nor expired family. "làm
// hàng thử" (id 3, "made trial product") is the same family as "test" -- included here too.
const TEST_REASON_KEYWORDS = ['test', 'hang thu'];
function reduceLossReasons(all: LabLossReason[]): LabLossReason[] {
  const filtered = all.filter(r => {
    const n = normalizeReasonName(r.name);
    return BROKEN_REASON_KEYWORDS.some(k => n.includes(k)) || EXPIRED_REASON_KEYWORDS.some(k => n.includes(k)) || TEST_REASON_KEYWORDS.some(k => n.includes(k));
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
  source: string; orderRef: string | null; photoUrl: string | null;
};

export async function getLabLossesAction(): Promise<{ losses?: LabLoss[]; error?: string }> {
  const auth = await requireStaff();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_internal_losses')
    .select('id, sku, product_name, qty, reason_tag_name, note, odoo_scrap_id, odoo_sync_error, reported_by_name, reported_at, source, order_ref, photo_url')
    .order('reported_at', { ascending: false })
    .limit(50);
  if (error) return { error: error.message };
  return {
    losses: (data ?? []).map(r => ({
      id: r.id, sku: r.sku, productName: r.product_name, qty: Number(r.qty),
      reasonTagName: r.reason_tag_name, note: r.note, odooScrapId: r.odoo_scrap_id, odooSyncError: r.odoo_sync_error,
      reportedByName: r.reported_by_name, reportedAt: r.reported_at,
      source: r.source ?? 'lab_scrap', orderRef: r.order_ref ?? null, photoUrl: r.photo_url ?? null,
    })),
  };
}

export async function recordLabLossAction(input: {
  sku: string | null; productName: string; qty: number;
  reasonTagId: number; reasonTagName: string; note: string | null; photoUrl?: string | null;
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
  // Same function as the delivery check "Bánh bị hỏng / vỡ" (Axel, 2026-10-24) — lib/lab-loss.ts.
  const r = await recordLabLoss(supabase, {
    sku: input.sku, productName, qty, reasonTagId: input.reasonTagId, reasonTagName: input.reasonTagName,
    note: input.note, reportedByName: auth.name || 'Staff', reportedById: auth.id, photoUrl: input.photoUrl ?? null, source: 'lab_scrap',
  });
  if (r.error) return { error: r.error };
  return { ok: true, odooSynced: !!r.odooScrapId, odooError: r.odooError ?? undefined };
}

// "Còn có thể báo" (Axel, 2026-10-24): for a made-to-order product, what is still physically at
// the Lab today = made − already delivered − already reported broken. Stock products: no limit.
export async function getLabScrapAvailabilityAction(sku: string): Promise<{ family?: string; made?: number; delivered?: number; lost?: number; available?: number; error?: string }> {
  const auth = await requireStaff();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase || !sku) return {};
  const today = labDateOf(new Date().toISOString())!;
  const { data: anyLine } = await supabase.from('lab_delivery_check_lines').select('product_category, category').eq('sku', sku).eq('delivery_date', today).limit(1).maybeSingle();
  const { pool } = await computeDayPool(supabase, today, sku, null, anyLine?.product_category ?? null, anyLine?.category ?? 'production');
  if (pool.family !== 'mto' || (pool.produced === 0 && pool.otherLeft === 0)) return { family: pool.family };
  return { family: pool.family, made: pool.produced, delivered: pool.otherLeft, lost: pool.lost, available: Math.max(0, pool.produced + pool.fromStock - pool.otherLeft - pool.lost) };
}
