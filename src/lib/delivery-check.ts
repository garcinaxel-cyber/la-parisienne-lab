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
  note: string | null;
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
  printed_at: string | null;
  printed_by_name: string | null;
  print_count: number;
  unlocked_at: string | null;
  unlocked_by_name: string | null;
}

// Packaging lines for one order_ref — plain Supabase read from the cron-synced table, no
// Odoo call on the request path at all. Also carries shop_name/source_type so a 100%-packaging
// order (nothing at all in lab_order_lines — e.g. REP/2026/01003, a pure supplies restock) can
// still resolve its header instead of showing a blank shop (2026-08-10).
async function fetchPackagingLines(supabase: SupabaseClient, orderRef: string) {
  const { data, error } = await supabase.from('lab_order_packaging_lines')
    .select('sku, product_name_vi, qty, shop_name, source_type, note').eq('order_ref', orderRef);
  if (error) throw error;
  return (data ?? []).map(p => ({ sku: p.sku, name: p.product_name_vi, qty: p.qty, shop_name: p.shop_name, source_type: p.source_type, note: p.note ?? null }));
}

export async function ensureDeliveryOrderChecklist(
  supabase: SupabaseClient, date: string, orderRef: string,
): Promise<{ header: DeliveryOrderHeader; lines: CheckLine[] }> {
  // lab_order_lines has NO product_name_en column (only product_name_vi) — selecting it
  // silently returned zero rows every time (PostgREST rejects unknown columns, and the
  // error wasn't being checked). Root cause of the 2026-08-08 "empty order" bug.
  // qty > 0 only: a cancelled Odoo line is zeroed by applyOdooChanges, never deleted (2026-08-11,
  // REP/2026/01012) — without this, a since-cancelled SKU would still get a bogus ×0 check line.
  const { data: orderLines, error: orderLinesError } = await supabase.from('lab_order_lines')
    .select('source_type, shop_name, product_sku, product_name_vi, team, qty, fiche_id, note')
    .eq('delivery_date', date).eq('order_ref', orderRef).gt('qty', 0);
  if (orderLinesError) throw orderLinesError;

  const packaging = await fetchPackagingLines(supabase, orderRef);

  // A 100%-packaging order (e.g. a pure supplies-restock replenishment, nothing to produce)
  // has NO lab_order_lines rows at all — fall back to the packaging rows for shop/source_type
  // so the header isn't blank (2026-08-10).
  const sourceType: SourceType =
    (orderLines?.[0]?.source_type as SourceType) ?? (packaging[0]?.source_type as SourceType) ??
    (orderRef.toUpperCase().startsWith('REP') ? 'replenishment' : 'sales_order');
  const shopName = orderLines?.[0]?.shop_name ?? packaging[0]?.shop_name ?? null;

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

  const { data: existingLines } = await supabase.from('lab_delivery_check_lines')
    .select('id, sku, category, product_category, note').eq('delivery_order_id', header.id);
  const existingKeys = new Set((existingLines ?? []).map((l: any) => `${l.category}||${l.sku}`));

  // Aggregate producible lines by SKU — a client's bon can carry the same SKU across two
  // variant rows (e.g. size), and the check is per SKU, not per variant, for now. Odoo notes
  // (replenishment line note, or a sales-order line_note row) are collected per SKU too —
  // kept as a Set so two different lines of the same SKU with two different notes both survive
  // instead of one clobbering the other (2026-08-11, discussed with Axel).
  const bySku: Record<string, { name_vi: string; name_en: string | null; team: string | null; ficheId: string | null; qty: number; notes: Set<string> }> = {};
  for (const l of orderLines ?? []) {
    const k = l.product_sku;
    const e = bySku[k] ??= { name_vi: l.product_name_vi, name_en: null, team: l.team, ficheId: l.fiche_id, qty: 0, notes: new Set() };
    e.qty += l.qty;
    if (l.note) e.notes.add(l.note);
  }

  // Product family (Macaron/Viennoiserie/Savory/...) for the category-picker view — resolved
  // from the fiche, not the chef team (teams are people-groups, not product families).
  const ficheIds = Array.from(new Set(Object.values(bySku).map(e => e.ficheId).filter(Boolean))) as string[];
  const { data: ficheRows } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, category').in('id', ficheIds)
    : { data: [] as any[] };
  const categoryByFiche: Record<string, string> = {};
  for (const f of ficheRows ?? []) if (f.category) categoryByFiche[f.id] = f.category;

  // A SKU permanently marked "not produced" (packaging, drinks, merchandise like a branded
  // spoon…) still gets a raw lab_order_lines row for the record/invoice, but was landing in
  // "Produits fabriqués" here regardless — this file only ever branched on which TABLE a line
  // came from (lab_order_lines vs lab_order_packaging_lines), never on lab_excluded_skus (Axel,
  // 2026-08-14, REP/2026/01039 "Thìa in logo" ITEM-Y08Q). Now routed to the packaging bucket
  // like any other non-produced item.
  const producibleSkus = Array.from(new Set(Object.keys(bySku)));
  const { data: excludedRows } = producibleSkus.length
    ? await supabase.from('lab_excluded_skus').select('sku').in('sku', producibleSkus)
    : { data: [] as any[] };
  const excludedSkuSet = new Set((excludedRows ?? []).map((r: any) => r.sku));

  // Self-heal: rows created before this resolution logic existed (or before their fiche had
  // a category set) got stuck with product_category = null forever, since the insert below
  // only fires for SKUs not already present. Backfill any resolvable ones on every open
  // instead of requiring a manual SQL fix each time (root cause of the 2026-08-08 "tout
  // passe en Autre" bug — confirmed every existing row had product_category null in DB).
  const packagingNoteBySku: Record<string, string> = {};
  for (const p of packaging) if (p.note) packagingNoteBySku[p.sku] = p.note;

  const toHeal: { id: string; patch: { product_category?: string; note?: string; category?: 'production' | 'packaging'; team?: string | null } }[] = [];
  for (const el of existingLines ?? []) {
    const patch: { product_category?: string; note?: string; category?: 'production' | 'packaging'; team?: string | null } = {};
    if (el.category === 'production') {
      const e = bySku[el.sku];
      // Re-check on every open, not just at creation — a SKU can get excluded AFTER its check
      // line already exists (or vice versa: un-excluded, but that side self-corrects for free
      // since a resolvable fiche's own product_category patch already runs below).
      if (el.sku && excludedSkuSet.has(el.sku)) {
        patch.category = 'packaging'; patch.product_category = 'Packaging'; patch.team = null;
      } else if (!el.product_category) {
        const resolved = e?.ficheId ? categoryByFiche[e.ficheId] : undefined;
        if (resolved) patch.product_category = resolved;
      }
      // Keeps re-syncing, not just backfilling once (2026-08-13, same freeze pattern as
      // qty_expected: a note added to lab_order_lines AFTER this check line already existed
      // used to never reach the screen, since this only ever fired when note was still null).
      // note is system-derived only — nothing in the UI lets an assistant hand-edit it — so
      // always overwriting with the current computed value is safe, nothing manual to protect.
      const computedNote = e?.notes.size ? Array.from(e.notes).join('\n') : null;
      if (computedNote && computedNote !== el.note) patch.note = computedNote;
    } else if (el.category === 'packaging') {
      // Packaging notes only started being synced 2026-08-11 (lab_order_packaging_lines.note) —
      // same re-sync pattern as production notes above (was backfill-on-null-only before).
      const computedPkgNote = packagingNoteBySku[el.sku] ?? null;
      if (computedPkgNote && computedPkgNote !== el.note) patch.note = computedPkgNote;
    }
    if (Object.keys(patch).length) toHeal.push({ id: el.id, patch });
  }
  for (const h of toHeal) {
    const { error: healError } = await supabase.from('lab_delivery_check_lines')
      .update(h.patch).eq('id', h.id);
    if (healError) throw healError;
  }

  const toInsert: any[] = [];
  for (const [sku, e] of Object.entries(bySku)) {
    const key = `production||${sku}`;
    if (existingKeys.has(key)) continue;
    const isExcluded = excludedSkuSet.has(sku);
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku,
      product_name_vi: e.name_vi, product_name_en: e.name_en,
      category: isExcluded ? 'packaging' : 'production',
      product_category: isExcluded ? 'Packaging' : (e.ficheId && categoryByFiche[e.ficheId]) || 'Autre',
      team: isExcluded ? null : e.team, qty_expected: e.qty,
      note: e.notes.size ? Array.from(e.notes).join('\n') : null,
    });
  }
  for (const p of packaging) {
    const key = `packaging||${p.sku}`;
    if (existingKeys.has(key)) continue;
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku: p.sku,
      product_name_vi: p.name, product_name_en: p.name,
      category: 'packaging', product_category: 'Packaging', team: null, qty_expected: p.qty,
      note: p.note ?? null,
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
