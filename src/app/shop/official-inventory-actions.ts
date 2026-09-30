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
import { isLastDayOfMonthVN, vnPeriodStr, odooExecute } from '@/lib/odoo';
import {
  getAllStockQuantsAtLocation, resolveProductsBySkuIncludingArchived, startGroupedInventoryCutoff,
  applyInventoryLines, tryCancelInventoryLine, type InventoryLineResult,
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
  /** Display-only grouping (Axel, 2026-09-30: "trier leur inventaire par catégorie"). */
  category: string;
  /** true = finished product (category from the recipe card), false = raw material/packaging/… */
  categoryIsProduct: boolean;
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

// Category per SKU, display-only (Axel, 2026-09-30: "trier leur inventaire par category of
// product que ce soit plus simple"). Finished products take the recipe card's category
// (lab_fiche_meta.category — same labels as the LAB inventory: Macaron, Biscuit Voyage, …).
// Everything without a card (raw materials, packaging, drinks, semi-finished…) falls back to the
// Odoo product category, mapped to a short Vietnamese label. Any failure here just degrades to
// "Khác" — it must never block loading the count screen.
const ODOO_CATEG_LABELS: [RegExp, string][] = [
  [/raw material|nguyên liệu/i, 'Nguyên liệu'],
  [/packaging|bao bì/i, 'Bao bì'],
  [/tiêu hao|expense/i, 'Vật tư tiêu hao'],
  [/semi-finished|bán thành phẩm/i, 'Bán thành phẩm'],
  [/drink|đồ uống/i, 'Đồ uống'],
];
async function categoriesBySku(skus: string[]): Promise<Record<string, { category: string; isProduct: boolean }>> {
  const out: Record<string, { category: string; isProduct: boolean }> = {};
  if (!skus.length) return out;
  const supabase = service();
  try {
    if (supabase) {
      const { data: vars } = await supabase.from('lab_fiche_variants').select('sku, fiche_id').in('sku', skus);
      const ficheIds = Array.from(new Set((vars ?? []).map((v: any) => v.fiche_id).filter(Boolean)));
      const { data: fiches } = ficheIds.length
        ? await supabase.from('lab_fiche_meta').select('id, category').in('id', ficheIds)
        : { data: [] as any[] };
      const catByFiche: Record<string, string> = {};
      const canon: Record<string, string> = {}; // "CheeseCake" / "Cheesecake" → one group
      for (const f of fiches ?? []) {
        const raw = String(f.category ?? '').trim();
        if (!raw || /^non production$/i.test(raw)) continue;
        const key = raw.toLowerCase();
        if (!canon[key]) canon[key] = raw.charAt(0).toUpperCase() + raw.slice(1);
        catByFiche[f.id] = canon[key];
      }
      for (const v of vars ?? []) {
        if (v.sku && catByFiche[v.fiche_id] && !out[v.sku]) out[v.sku] = { category: catByFiche[v.fiche_id], isProduct: true };
      }
    }
  } catch { /* display-only */ }
  const missing = skus.filter(sku => !out[sku]);
  if (missing.length) {
    try {
      const prods = await odooExecute<any[]>('product.product', 'search_read',
        [[['default_code', 'in', missing]]], { fields: ['default_code', 'categ_id'], limit: 2000, context: { active_test: false } });
      for (const p of prods) {
        if (!p.default_code || out[p.default_code]) continue;
        const name = Array.isArray(p.categ_id) ? String(p.categ_id[1]) : '';
        const hit = ODOO_CATEG_LABELS.find(([re]) => re.test(name));
        out[p.default_code] = { category: hit ? hit[1] : 'Khác', isProduct: false };
      }
    } catch { /* display-only */ }
  }
  for (const sku of missing) if (!out[sku]) out[sku] = { category: 'Khác', isProduct: false };
  return out;
}

async function mapLine(row: any, imgBySku: Record<string, string | null>, catBySku: Record<string, { category: string; isProduct: boolean }> = {}): Promise<OfficialInventoryLine> {
  return {
    id: row.id, sku: row.sku, productName: row.product_name ?? row.sku,
    qtyTheoretical: row.qty_theoretical === null ? null : Number(row.qty_theoretical),
    qtyCounted: Number(row.qty_counted ?? 0),
    imageUrl: imgBySku[row.sku] ?? null,
    odooPushStatus: row.odoo_push_status ?? null, odooPushError: row.odoo_push_error ?? null,
    category: catBySku[row.sku]?.category ?? 'Khác',
    categoryIsProduct: catBySku[row.sku]?.isProduct ?? false,
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
  const [imgBySku, catBySku] = await Promise.all([imageUrlsBySku(skus), categoriesBySku(skus)]);
  const lines = await Promise.all((lineRows ?? []).map((l: any) => mapLine(l, imgBySku, catBySku)));

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
  if (sessErr || !created) {
    // Never leave the Odoo cut-off orphaned without an app session (2026-09-30, Timecity).
    console.error('[official-inventory] session insert failed', { shop: auth.shopName, period, error: sessErr?.message });
    if (cutoff.odooInventoryId) await tryCancelInventoryLine(cutoff.odooInventoryId);
    return { error: sessErr?.message ?? 'Échec de la création de la session' };
  }

  const nameBySku: Record<string, string> = {};
  for (const q of quants) nameBySku[q.sku] = q.name;
  const lineRows = cutoff.lines.map(l => ({
    session_id: created.id, sku: l.sku, product_name: nameBySku[l.sku] ?? l.sku,
    qty_theoretical: l.qtyTheoretical, qty_counted: 0, odoo_count_line_id: l.odooCountLineId,
    updated_at: new Date().toISOString(),
  }));
  const { error: linesErr } = await supabase.from('lab_shop_official_inventory_lines').insert(lineRows);
  if (linesErr) {
    console.error('[official-inventory] lines insert failed', { shop: auth.shopName, period, error: linesErr.message });
    await supabase.from('lab_shop_official_inventory_sessions').delete().eq('id', created.id);
    if (cutoff.odooInventoryId) await tryCancelInventoryLine(cutoff.odooInventoryId);
    return { error: linesErr.message };
  }

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
 *  top of current Odoo stock (never an overwrite), via `action_apply_count_lines` ("Apply Count Sheet") then `action_state_to_done`
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
