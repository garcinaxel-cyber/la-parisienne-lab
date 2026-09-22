'use server';
// Shops' monthly OFFICIAL inventory (Axel, 2026-09-22) — separate from the daily Kiểm kho
// (saveStockCountAction/finishStockCountAction in ./actions.ts), which stays 100% Odoo-free,
// always. This one session per shop per month is gated to the last day of the month and pushes to
// Odoo via the same cut-off/diff mechanism as the lab (src/lib/odoo-inventory.ts), against the
// shop's own warehouse location — never LAB — with a single grouped cut-off covering every SKU at
// once (see startGroupedInventoryCutoff's doc comment for why that differs from the lab's
// per-SKU/lazy approach: here, an uncounted product must still default to 0 and be pushed as such,
// so every SKU needs its theoretical frozen from the start, not only the ones actually typed).
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireShopOrStaffSession } from './actions';
import { resolveShopWarehouseLocation } from '@/lib/odoo-scrap';
import { isLastDayOfMonthVN, vnPeriodStr } from '@/lib/odoo';
import {
  getAllStockQuantsAtLocation, resolveProductsBySkuIncludingArchived, startGroupedInventoryCutoff,
  applyInventoryLines, type InventoryLineResult,
} from '@/lib/odoo-inventory';

// Same local service-role-client pattern as every other 'use server' action file in this app
// (actions.ts, shop-manager/actions.ts, station/[team]/actions.ts, …) — used only after the
// caller's own session/role has been verified via requireShopOrStaffSession above.
function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

export type OfficialInventorySessionStatus = 'draft' | 'submitted';

export interface OfficialInventoryLine {
  id: string;
  sku: string;
  productName: string;
  qtyTheoretical: number | null;
  qtyCounted: number;
  imageUrl: string | null;
  odooPushStatus: string | null;
  odooPushError: string | null;
}

export interface OfficialInventorySession {
  id: string;
  period: string;
  status: OfficialInventorySessionStatus;
  createdByName: string | null;
  submittedAt: string | null;
  submittedByName: string | null;
  odooPushStatus: string | null;
  odooPushError: string | null;
}

// Product photos (Axel: "je veux la photo des produits") — same source the daily stock-count
// checklist already uses (lab_fiche_variants.image_url, falling back to the recipe card's own
// image_url), keyed by SKU. Read-only, no Odoo involved.
async function imageUrlsBySku(skus: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const supabase = service();
  if (!supabase || !skus.length) return out;
  const { data: vars } = await supabase.from('lab_fiche_variants').select('sku, fiche_id, image_url').in('sku', skus);
  const ficheIds = Array.from(new Set((vars ?? []).map((v: any) => v.fiche_id).filter(Boolean)));
  const { data: fiches } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, image_url').in('id', ficheIds)
    : { data: [] as any[] };
  const ficheById: Record<string, any> = {};
  for (const f of fiches ?? []) ficheById[f.id] = f;
  for (const v of vars ?? []) {
    if (!v.sku) continue;
    out[v.sku] = v.image_url ?? ficheById[v.fiche_id]?.image_url ?? null;
  }
  return out;
}

async function mapLine(row: any, imgBySku: Record<string, string | null>): Promise<OfficialInventoryLine> {
  return {
    id: row.id, sku: row.sku, productName: row.product_name ?? row.sku,
    qtyTheoretical: row.qty_theoretical === null ? null : Number(row.qty_theoretical),
    qtyCounted: Number(row.qty_counted ?? 0),
    imageUrl: imgBySku[row.sku] ?? null,
    odooPushStatus: row.odoo_push_status ?? null, odooPushError: row.odoo_push_error ?? null,
  };
}

function mapSession(row: any): OfficialInventorySession {
  return {
    id: row.id, period: row.period, status: row.status,
    createdByName: row.created_by_name ?? null,
    submittedAt: row.submitted_at ?? null, submittedByName: row.submitted_by_name ?? null,
    odooPushStatus: row.odoo_push_status ?? null, odooPushError: row.odoo_push_error ?? null,
  };
}

export interface OfficialInventoryState {
  shopName?: string;
  isLastDay?: boolean;
  hasWarehouse?: boolean;
  period?: string;
  session?: OfficialInventorySession | null;
  lines?: OfficialInventoryLine[];
  error?: string;
}

/** Everything the shop screen needs in one round-trip: is today the last day of the month, does
 *  this shop even have an Odoo warehouse, and — if a session already exists for the current
 *  period OR an earlier draft was left open past midnight (started at 23:5x, finished after
 *  00:0x) — its current state. */
export async function getOfficialInventoryStateAction(shopName?: string): Promise<OfficialInventoryState> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const period = vnPeriodStr();
  const loc = await resolveShopWarehouseLocation(auth.shopName);

  const { data: rows } = await supabase.from('lab_shop_official_inventory_sessions')
    .select('*').eq('shop_name', auth.shopName)
    .or(`period.eq.${period},status.eq.draft`)
    .order('created_at', { ascending: false }).limit(1);
  const row = rows?.[0] ?? null;
  if (!row) return { shopName: auth.shopName, isLastDay: isLastDayOfMonthVN(), hasWarehouse: !!loc, period, session: null, lines: [] };

  const { data: lineRows } = await supabase.from('lab_shop_official_inventory_lines')
    .select('*').eq('session_id', row.id).order('sku', { ascending: true });
  const skus = (lineRows ?? []).map((l: any) => l.sku as string);
  const imgBySku = await imageUrlsBySku(skus);
  const lines = await Promise.all((lineRows ?? []).map((l: any) => mapLine(l, imgBySku)));

  return {
    shopName: auth.shopName, isLastDay: isLastDayOfMonthVN(), hasWarehouse: !!loc,
    period, session: mapSession(row), lines,
  };
}

export interface StartOfficialInventoryResult { ok?: boolean; sessionId?: string; lineCount?: number; error?: string; }

/** Opens the month's official session for this shop — reuses an existing draft (idempotent,
 *  no duplicate Odoo cut-off) if one is already open; otherwise only allowed on the last day of
 *  the month, and freezes the theoretical for the shop's ENTIRE Odoo warehouse in one grouped
 *  cut-off. */
export async function startOfficialInventoryAction(startedByName: string, shopName?: string): Promise<StartOfficialInventoryResult> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const name = (startedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Nom requis' };

  const { data: existingDraft } = await supabase.from('lab_shop_official_inventory_sessions')
    .select('id').eq('shop_name', auth.shopName).eq('status', 'draft')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existingDraft) return { ok: true, sessionId: existingDraft.id };

  if (!isLastDayOfMonthVN()) return { error: 'L\'inventaire officiel ne peut être démarré que le dernier jour du mois' };

  const loc = await resolveShopWarehouseLocation(auth.shopName);
  if (!loc) return { error: 'Cette boutique n\'a pas d\'entrepôt Odoo — inventaire officiel indisponible' };

  const period = vnPeriodStr();
  // Full warehouse snapshot (quants), archived products included — gives us the SKU/name/qty list
  // AND is how a product discontinued on Odoo but still physically in stock stays on the list.
  const quants = await getAllStockQuantsAtLocation(loc.locationId, true);
  if (!quants.length) return { error: 'Aucun produit trouvé sur Odoo pour cet entrepôt' };
  const skus = quants.map(q => q.sku);
  const productBySku = await resolveProductsBySkuIncludingArchived(skus);
  const products = skus.map(sku => productBySku[sku] ? { sku, id: productBySku[sku].id } : null).filter((p): p is { sku: string; id: number } => !!p);
  if (!products.length) return { error: 'Aucun produit Odoo résolu pour cet entrepôt' };

  const cutoff = await startGroupedInventoryCutoff(loc.locationId, products, `Inventaire officiel — ${auth.shopName} — ${period}`);
  if (!cutoff.ok || !cutoff.lines) return { error: cutoff.error ?? 'Échec de l\'ouverture du comptage sur Odoo' };

  const { data: created, error: sessErr } = await supabase.from('lab_shop_official_inventory_sessions').insert({
    shop_name: auth.shopName, period, status: 'draft',
    odoo_location_id: loc.locationId, odoo_inventory_id: cutoff.odooInventoryId,
    created_by_name: name, updated_at: new Date().toISOString(),
  }).select('id').single();
  if (sessErr || !created) return { error: sessErr?.message ?? 'Échec de la création de la session' };

  const nameBySku: Record<string, string> = {};
  for (const q of quants) nameBySku[q.sku] = q.name;
  const lineRows = cutoff.lines.map(l => ({
    session_id: created.id, sku: l.sku, product_name: nameBySku[l.sku] ?? l.sku,
    qty_theoretical: l.qtyTheoretical, qty_counted: 0, odoo_count_line_id: l.odooCountLineId,
    updated_at: new Date().toISOString(),
  }));
  const { error: linesErr } = await supabase.from('lab_shop_official_inventory_lines').insert(lineRows);
  if (linesErr) return { error: linesErr.message };

  return { ok: true, sessionId: created.id, lineCount: lineRows.length };
}

export interface SaveOfficialLineResult { ok?: boolean; error?: string; }

export async function saveOfficialInventoryLineAction(
  sessionId: string, sku: string, qty: number, updatedByName: string, shopName?: string,
): Promise<SaveOfficialLineResult> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  if (!Number.isFinite(qty) || qty < 0) return { error: 'Quantité invalide' };

  const { data: sess } = await supabase.from('lab_shop_official_inventory_sessions')
    .select('id, shop_name, status').eq('id', sessionId).maybeSingle();
  if (!sess || sess.shop_name !== auth.shopName) return { error: 'Session introuvable' };
  if (sess.status !== 'draft') return { error: 'Inventaire déjà envoyé — modification impossible' };

  const name = (updatedByName ?? '').trim().slice(0, 80);
  const { error } = await supabase.from('lab_shop_official_inventory_lines')
    .update({ qty_counted: qty, updated_by_name: name || null, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId).eq('sku', sku);
  if (error) return { error: error.message };
  return { ok: true };
}

export interface SubmitOfficialInventoryResult {
  ok?: boolean; pushStatus?: 'success' | 'partial' | 'error'; errorCount?: number;
  lines?: InventoryLineResult[]; error?: string;
}

/** Final "Envoyer à Odoo" — applies the whole session's counted quantities as the real diff on
 *  top of current Odoo stock (never an overwrite), in one grouped `action_state_to_done` call
 *  under the hood since every line shares the same `odoo_inventory_id`. */
export async function submitOfficialInventoryAction(
  sessionId: string, submittedByName: string, shopName?: string,
): Promise<SubmitOfficialInventoryResult> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const name = (submittedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Nom requis' };

  const { data: sess } = await supabase.from('lab_shop_official_inventory_sessions')
    .select('id, shop_name, status').eq('id', sessionId).maybeSingle();
  if (!sess || sess.shop_name !== auth.shopName) return { error: 'Session introuvable' };
  if (sess.status !== 'draft') return { error: 'Inventaire déjà envoyé' };

  const { data: lineRows } = await supabase.from('lab_shop_official_inventory_lines')
    .select('id, sku, qty_counted, odoo_count_line_id').eq('session_id', sessionId);
  const withLine = (lineRows ?? []).filter((l: any) => l.odoo_count_line_id);
  const missing = (lineRows ?? []).filter((l: any) => !l.odoo_count_line_id);
  if (!withLine.length) return { error: 'Aucune ligne à envoyer' };

  const res = await applyInventoryLines(withLine.map((l: any) => ({ odooCountLineId: l.odoo_count_line_id, qtyCounted: Number(l.qty_counted ?? 0) })));
  if (!res.ok) {
    await supabase.from('lab_shop_official_inventory_sessions').update({
      odoo_push_status: 'error', odoo_push_error: res.error ?? 'Erreur inconnue', updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    return { error: res.error };
  }

  const byLineId: Record<number, InventoryLineResult> = {};
  for (const r of res.lines) byLineId[(r as any).odooCountLineId] = r;
  await Promise.all(withLine.map((l: any) => {
    const r = byLineId[l.odoo_count_line_id];
    if (!r) return Promise.resolve();
    return supabase.from('lab_shop_official_inventory_lines').update({
      odoo_push_status: r.ok ? 'success' : 'error', odoo_push_error: r.error ?? null, updated_at: new Date().toISOString(),
    }).eq('id', l.id);
  }));
  await Promise.all(missing.map((l: any) =>
    supabase.from('lab_shop_official_inventory_lines').update({
      odoo_push_status: 'error', odoo_push_error: 'Comptage jamais ouvert sur Odoo', updated_at: new Date().toISOString(),
    }).eq('id', l.id)
  ));

  const allLines: InventoryLineResult[] = [
    ...res.lines.map(r => ({ sku: withLine.find((l: any) => l.odoo_count_line_id === (r as any).odooCountLineId)?.sku ?? r.sku, found: r.found, qtySystem: r.qtySystem, qtyCounted: r.qtyCounted, diff: r.diff, ok: r.ok, error: r.error })),
    ...missing.map((l: any) => ({ sku: l.sku, found: false, qtySystem: null, qtyCounted: Number(l.qty_counted ?? 0), diff: null, ok: false, error: 'Comptage jamais ouvert sur Odoo' })),
  ];
  const errorCount = allLines.filter(r => !r.ok).length;
  const pushStatus: 'success' | 'partial' | 'error' = errorCount === 0 ? 'success' : errorCount === allLines.length ? 'error' : 'partial';

  await supabase.from('lab_shop_official_inventory_sessions').update({
    status: 'submitted', submitted_at: new Date().toISOString(), submitted_by_name: name,
    odoo_push_status: pushStatus, odoo_push_error: errorCount ? `${errorCount} ligne(s) en erreur` : null,
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);

  return { ok: true, pushStatus, errorCount, lines: allLines };
}
