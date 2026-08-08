// Assistant delivery-check: materializes lab_delivery_orders + lab_delivery_check_lines for
// one (date, order_ref) on first open. Producible items come from lab_order_lines (already
// imported); packaging/matières lines come from lab_order_packaging_lines, synced on the same
// 15-min cron as everything else (see odoo-packaging-sync.ts) — NOT read live from Odoo here.
// Reusing lab_order_lines directly for packaging would break the reconciliation feature
// (expects every order-line row to eventually be produced); an earlier version of this file
// fetched packaging live from Odoo on every page view, which was slow (2-3 Odoo round trips
// per order, multiplied across every order on the category view) — Axel asked to piggyback
// on the existing cron instead of mobilizing a separate on-demand API call (2026-08-08).
import type { SupabaseClient } from '@supabase/supabase-js';

export type SourceType = 'sales_order' | 'replenishment';

export interface CheckLine {
  id: string;
  delivery_date: string;
  sku: string | null;
  product_name_vi: string;
  product_name_en: string | null;
  category: 'production' | 'packaging';
  product_category: string | null;
  team: string | null;
  qty_expected: number;
  qty_checked: number | null;
  status: 'pending' | 'ok' | 'adjusted';
  discrepancy_reason: string | null;
  discrepancy_note: string | null;
  checked_by_name: string | null;
  checked_at: string | null;
}

export interface DeliveryOrderHeader {
  id: string;
  delivery_date: string;
  order_ref: string;
  source_type: SourceType;
  shop_name: string | null;
  customer_name: string | null;
  status: 'in_progress' | 'validated';
  validated_at: string | null;
  validated_by_name: string | null;
  odoo_push_status: string | null;
  odoo_push_error: string | null;
}

// Packaging lines for one order_ref — plain Supabase read from the cron-synced table, no
// Odoo call on the request path at all.
async function fetchPackagingLines(supabase: SupabaseClient, orderRef: string) {
  const { data, error } = await supabase.from('lab_order_packaging_lines')
    .select('sku, product_name_vi, qty').eq('order_ref', orderRef);
  if (error) throw error;
  return (data ?? []).map(p => ({ sku: p.sku, name: p.product_name_vi, qty: p.qty }));
}

export async function ensureDeliveryOrderChecklist(
  supabase: SupabaseClient, date: string, orderRef: string,
): Promise<{ header: DeliveryOrderHeader; lines: CheckLine[] }> {
  // lab_order_lines has NO product_name_en column (only product_name_vi) — selecting it
  // silently returned zero rows every time (PostgREST rejects unknown columns, and the
  // error wasn't being checked). Root cause of the 2026-08-08 "empty order" bug.
  const { data: orderLines, error: orderLinesError } = await supabase.from('lab_order_lines')
    .select('source_type, shop_name, product_sku, product_name_vi, team, qty, fiche_id')
    .eq('delivery_date', date).eq('order_ref', orderRef);
  if (orderLinesError) throw orderLinesError;

  const sourceType: SourceType =
    (orderLines?.[0]?.source_type as SourceType) ?? (orderRef.toUpperCase().startsWith('REP') ? 'replenishment' : 'sales_order');
  const shopName = orderLines?.[0]?.shop_name ?? null;

  const { data: existingHeader } = await supabase.from('lab_delivery_orders')
    .select('*').eq('delivery_date', date).eq('order_ref', orderRef).maybeSingle();
  let header = existingHeader as DeliveryOrderHeader | null;
  if (!header) {
    const { data: created, error } = await supabase.from('lab_delivery_orders')
      .insert({ delivery_date: date, order_ref: orderRef, source_type: sourceType, shop_name: shopName })
      .select('*').single();
    if (error) throw error;
    header = created as DeliveryOrderHeader;
  }

  const packaging = await fetchPackagingLines(supabase, orderRef);

  const { data: existingLines } = await supabase.from('lab_delivery_check_lines')
    .select('id, sku, category, product_category').eq('delivery_order_id', header.id);
  const existingKeys = new Set((existingLines ?? []).map((l: any) => `${l.category}||${l.sku}`));

  // Aggregate producible lines by SKU — a client's bon can carry the same SKU across two
  // variant rows (e.g. size), and the check is per SKU, not per variant, for now.
  const bySku: Record<string, { name_vi: string; name_en: string | null; team: string | null; ficheId: string | null; qty: number }> = {};
  for (const l of orderLines ?? []) {
    const k = l.product_sku;
    const e = bySku[k] ??= { name_vi: l.product_name_vi, name_en: null, team: l.team, ficheId: l.fiche_id, qty: 0 };
    e.qty += l.qty;
  }

  // Product family (Macaron/Viennoiserie/Savory/...) for the category-picker view — resolved
  // from the fiche, not the chef team (teams are people-groups, not product families).
  const ficheIds = Array.from(new Set(Object.values(bySku).map(e => e.ficheId).filter(Boolean))) as string[];
  const { data: ficheRows } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, category').in('id', ficheIds)
    : { data: [] as any[] };
  const categoryByFiche: Record<string, string> = {};
  for (const f of ficheRows ?? []) if (f.category) categoryByFiche[f.id] = f.category;

  // Self-heal: rows created before this resolution logic existed (or before their fiche had
  // a category set) got stuck with product_category = null forever, since the insert below
  // only fires for SKUs not already present. Backfill any resolvable ones on every open
  // instead of requiring a manual SQL fix each time (root cause of the 2026-08-08 "tout
  // passe en Autre" bug — confirmed every existing row had product_category null in DB).
  const toHeal: { id: string; product_category: string }[] = [];
  for (const el of existingLines ?? []) {
    if (el.category !== 'production' || el.product_category) continue;
    const e = bySku[el.sku];
    const resolved = e?.ficheId ? categoryByFiche[e.ficheId] : undefined;
    if (resolved) toHeal.push({ id: el.id, product_category: resolved });
  }
  for (const h of toHeal) {
    const { error: healError } = await supabase.from('lab_delivery_check_lines')
      .update({ product_category: h.product_category }).eq('id', h.id);
    if (healError) throw healError;
  }

  const toInsert: any[] = [];
  for (const [sku, e] of Object.entries(bySku)) {
    const key = `production||${sku}`;
    if (existingKeys.has(key)) continue;
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku,
      product_name_vi: e.name_vi, product_name_en: e.name_en,
      category: 'production', product_category: (e.ficheId && categoryByFiche[e.ficheId]) || 'Autre',
      team: e.team, qty_expected: e.qty,
    });
  }
  for (const p of packaging) {
    const key = `packaging||${p.sku}`;
    if (existingKeys.has(key)) continue;
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku: p.sku,
      product_name_vi: p.name, product_name_en: p.name,
      category: 'packaging', product_category: 'Packaging', team: null, qty_expected: p.qty,
    });
  }
  if (toInsert.length) {
    const { error: insertError } = await supabase.from('lab_delivery_check_lines').insert(toInsert);
    if (insertError) throw insertError;
  }

  const { data: lines, error: linesError } = await supabase.from('lab_delivery_check_lines')
    .select('*').eq('delivery_order_id', header.id).order('category', { ascending: true }).order('product_name_vi', { ascending: true });
  if (linesError) throw linesError;

  return { header, lines: (lines ?? []) as CheckLine[] };
}

export interface UnreconciledLine extends CheckLine {
  manual_cake_id: string;
  customer_name: string | null;
  customer_phone: string | null;
}

// 3rd panier: manual cakes for the date range with no Odoo order behind them yet
// (matched_order_ref null, not cancelled) — nothing to push to Odoo, checking here is
// purely the assistant's own tracking. Materializes one check_line per pending cake.
export async function ensureUnreconciledChecklist(
  supabase: SupabaseClient, dates: string[],
): Promise<UnreconciledLine[]> {
  const { data: cakes, error: cakesError } = await supabase.from('lab_manual_cakes')
    .select('id, product_name_vi, product_name_en, product_sku, qty, delivery_date, customer_name, customer_phone')
    .in('delivery_date', dates).is('matched_order_ref', null).is('cancelled_at', null);
  if (cakesError) throw cakesError;
  if (!cakes?.length) return [];

  const cakeIds = cakes.map(c => c.id);
  const { data: existing, error: existingError } = await supabase.from('lab_delivery_check_lines')
    .select('*').in('manual_cake_id', cakeIds);
  if (existingError) throw existingError;
  const existingByCake: Record<string, any> = {};
  for (const l of existing ?? []) existingByCake[l.manual_cake_id] = l;

  const toInsert = cakes.filter(c => !existingByCake[c.id]).map(c => ({
    manual_cake_id: c.id, delivery_date: c.delivery_date, sku: c.product_sku,
    product_name_vi: c.product_name_vi, product_name_en: c.product_name_en,
    category: 'production', qty_expected: c.qty,
  }));
  if (toInsert.length) {
    const { error: insertError } = await supabase.from('lab_delivery_check_lines').insert(toInsert);
    if (insertError) throw insertError;
  }

  const { data: lines, error: linesError } = await supabase.from('lab_delivery_check_lines')
    .select('*').in('manual_cake_id', cakeIds);
  if (linesError) throw linesError;

  const cakeById: Record<string, any> = {};
  for (const c of cakes) cakeById[c.id] = c;
  return (lines ?? []).map((l: any) => ({
    ...l,
    customer_name: cakeById[l.manual_cake_id]?.customer_name ?? null,
    customer_phone: cakeById[l.manual_cake_id]?.customer_phone ?? null,
  })) as UnreconciledLine[];
}
