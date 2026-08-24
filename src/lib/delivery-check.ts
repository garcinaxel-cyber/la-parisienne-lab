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
  hidden_from_print: boolean;
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
  odoo_picking_ids: number[] | null;
  odoo_validated_at: string | null;
  odoo_validated_by_name: string | null;
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
    .select('id, sku, category, product_category, note, qty_expected').eq('delivery_order_id', header.id);
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
  const packagingQtyBySku: Record<string, number> = {};
  for (const p of packaging) {
    if (p.note) packagingNoteBySku[p.sku] = p.note;
    packagingQtyBySku[p.sku] = (packagingQtyBySku[p.sku] ?? 0) + p.qty;
  }
  // An excluded SKU's own lab_order_lines demand belongs in the SAME packaging bucket as its
  // (possibly separate) lab_order_packaging_lines row for that sku — merged here so nothing
  // downstream ever has to choose between the two sources. Previously these were pushed as two
  // competing toInsert rows under the same (category, sku) key below, and the upsert's
  // ignoreDuplicates silently dropped whichever landed second — undercounting the app total by
  // the packaging-only share (2026-08-24, Axel: REP/2026/01154 152-MH.362 showing "2" in the app
  // vs a true Odoo total of "3" = 2 production-side + 1 packaging-side).
  for (const [sku, e] of Object.entries(bySku)) {
    if (excludedSkuSet.has(sku)) packagingQtyBySku[sku] = (packagingQtyBySku[sku] ?? 0) + e.qty;
  }

  const toHeal: { id: string; patch: { product_category?: string; note?: string; category?: 'production' | 'packaging'; team?: string | null; qty_expected?: number } }[] = [];
  for (const el of existingLines ?? []) {
    const patch: { product_category?: string; note?: string; category?: 'production' | 'packaging'; team?: string | null; qty_expected?: number } = {};
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
      // Qty resync (2026-08-24, Axel: REP/2026/01154 VTTH950/VTTH069/152-MH.128 — Odoo's
      // packaging qty dropped but the checklist stayed frozen at the old value forever, since
      // qty_expected was never re-synced for packaging anywhere. Production lines get this via
      // applyOdooChanges' explicit Odoo-delta detection (2026-08-13) — packaging has no
      // equivalent delta mechanism at all: odoo-packaging-sync.ts always upserts the CURRENT
      // Odoo qty into lab_order_packaging_lines on every cron tick (no old-vs-new comparison
      // there), so re-deriving qty_expected here on every checklist reopen is the correct place
      // to close the gap, not a workaround. Same safety property as the production-line fix:
      // qty_checked (what staff already physically counted) is a separate column, left
      // untouched — the UI's existing qty_checked vs qty_expected diff surfaces any mismatch on
      // its own instead of silently erasing completed work.
      if (el.sku) {
        const computedQty = packagingQtyBySku[el.sku];
        if (computedQty !== undefined && computedQty !== el.qty_expected) patch.qty_expected = computedQty;
      }
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
    if (excludedSkuSet.has(sku)) continue; // routed entirely through the packaging bucket below
    const key = `production||${sku}`;
    if (existingKeys.has(key)) continue;
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku,
      product_name_vi: e.name_vi, product_name_en: e.name_en,
      category: 'production',
      product_category: (e.ficheId && categoryByFiche[e.ficheId]) || 'Autre',
      team: e.team, qty_expected: e.qty,
      note: e.notes.size ? Array.from(e.notes).join('\n') : null,
    });
  }
  // Packaging bucket — one row per sku, merging real lab_order_packaging_lines rows with any
  // excluded-SKU lab_order_lines demand for that same sku (packagingQtyBySku above already sums
  // both sources). 2026-08-24 fix: previously a sku that was BOTH excluded-production AND a real
  // packaging row generated two competing toInsert entries under the identical (category, sku)
  // upsert key — the ignoreDuplicates upsert silently kept only one, dropping the other's qty.
  const packagingSkus = Array.from(new Set<string>([
    ...packaging.map(p => p.sku),
    ...Object.keys(bySku).filter(sku => excludedSkuSet.has(sku)),
  ]));
  for (const sku of packagingSkus) {
    const key = `packaging||${sku}`;
    if (existingKeys.has(key)) continue;
    const pkgRow = packaging.find(p => p.sku === sku);
    const prodRow = bySku[sku];
    const name = pkgRow?.name ?? prodRow?.name_vi ?? sku;
    const note = pkgRow?.note ?? (prodRow?.notes.size ? Array.from(prodRow.notes).join('\n') : null);
    toInsert.push({
      delivery_order_id: header.id, delivery_date: date, sku,
      product_name_vi: name, product_name_en: name,
      category: 'packaging', product_category: 'Packaging', team: null,
      qty_expected: packagingQtyBySku[sku] ?? 0,
      note,
    });
  }
  if (toInsert.length) {
    // upsert + ignoreDuplicates, not insert — two concurrent page loads (e.g. two tabs open on
    // the category view) both running this same read-then-insert sequence could each decide a
    // line was missing and both insert it, with nothing stopping the race (2026-08-14 bug: 86
    // duplicate rows found for one order+SKU). The lab_v39 unique index on
    // (delivery_order_id, category, sku) makes this the DB-enforced backstop, not just this
    // check — ignoreDuplicates means the loser of the race silently no-ops instead of erroring.
    const { error: insertError } = await supabase.from('lab_delivery_check_lines')
      .upsert(toInsert, { onConflict: 'delivery_order_id,category,sku', ignoreDuplicates: true });
    if (insertError) throw insertError;
  }

  const { data: lines, error: linesError } = await supabase.from('lab_delivery_check_lines')
    .select('*').eq('delivery_order_id', header.id).order('category', { ascending: true }).order('product_name_vi', { ascending: true });
  if (linesError) throw linesError;

  return { header, lines: (lines ?? []) as CheckLine[] };
}

// Batched sibling of ensureDeliveryOrderChecklist, for LIST pages (category, by-shop) that
// otherwise call the single-order function once PER order in a Promise.all loop — each call
// issuing ~7 separate Supabase queries, so a page showing 20-30 open orders was making
// 150-200+ round trips (2026-08-24, Axel: reduce Supabase read volume on the free plan;
// lab_delivery_check_lines/lab_order_lines/lab_fiche_meta/lab_excluded_skus were each seeing
// 5,000-11,000 reads/day). This function fetches every table ONCE for the whole batch of orders
// instead of once per order, then runs the EXACT SAME per-order computation as
// ensureDeliveryOrderChecklist (self-heal, exclusion routing, packaging merge) on the
// batch-fetched data sliced by order — the business logic is not changed, only where the raw
// rows come from. Returns a Map keyed by "date||order_ref", one entry per input order (missing
// only if that order's header/lines genuinely failed to resolve).
export async function ensureDeliveryOrderChecklistsBatch(
  supabase: SupabaseClient, orders: { delivery_date: string; order_ref: string }[],
): Promise<Map<string, { header: DeliveryOrderHeader; lines: CheckLine[] }>> {
  const result = new Map<string, { header: DeliveryOrderHeader; lines: CheckLine[] }>();
  if (!orders.length) return result;

  const refs = Array.from(new Set(orders.map(o => o.order_ref)));
  const dates = Array.from(new Set(orders.map(o => o.delivery_date)));
  const dateByRef: Record<string, string> = {};
  for (const o of orders) dateByRef[o.order_ref] = o.delivery_date;

  const { data: allOrderLines, error: orderLinesError } = await supabase.from('lab_order_lines')
    .select('order_ref, source_type, shop_name, product_sku, product_name_vi, team, qty, fiche_id, note')
    .in('order_ref', refs).in('delivery_date', dates).gt('qty', 0);
  if (orderLinesError) throw orderLinesError;

  const { data: allPackaging, error: packagingError } = await supabase.from('lab_order_packaging_lines')
    .select('order_ref, sku, product_name_vi, qty, shop_name, source_type, note')
    .in('order_ref', refs);
  if (packagingError) throw packagingError;

  const orderLinesByRef = new Map<string, any[]>();
  for (const l of allOrderLines ?? []) (orderLinesByRef.get(l.order_ref) ?? orderLinesByRef.set(l.order_ref, []).get(l.order_ref)!).push(l);
  const packagingByRef = new Map<string, { sku: string; name: string; qty: number; shop_name: string | null; source_type: string; note: string | null }[]>();
  for (const p of allPackaging ?? []) {
    const arr = packagingByRef.get(p.order_ref) ?? packagingByRef.set(p.order_ref, []).get(p.order_ref)!;
    arr.push({ sku: p.sku, name: p.product_name_vi, qty: p.qty, shop_name: p.shop_name, source_type: p.source_type, note: p.note ?? null });
  }

  // Headers — batch-fetch existing ones; any missing (rare in steady state: created once, the
  // first time anyone opens that order's checklist, then reused forever) are inserted one at a
  // time exactly like the single-order path — low volume, not worth the complexity of a bulk
  // insert with race-safe id mapping.
  const { data: existingHeaders } = await supabase.from('lab_delivery_orders')
    .select('*').in('order_ref', refs).in('delivery_date', dates);
  const headerByRef = new Map<string, DeliveryOrderHeader>();
  for (const h of existingHeaders ?? []) headerByRef.set((h as any).order_ref, h as DeliveryOrderHeader);

  for (const ref of refs) {
    if (headerByRef.has(ref)) continue;
    const date = dateByRef[ref];
    const orderLines = orderLinesByRef.get(ref) ?? [];
    const packaging = packagingByRef.get(ref) ?? [];
    const sourceType: SourceType =
      (orderLines[0]?.source_type as SourceType) ?? (packaging[0]?.source_type as SourceType) ??
      (ref.toUpperCase().startsWith('REP') ? 'replenishment' : 'sales_order');
    const shopName = orderLines[0]?.shop_name ?? packaging[0]?.shop_name ?? null;
    const { data: created, error } = await supabase.from('lab_delivery_orders')
      .insert({ delivery_date: date, order_ref: ref, source_type: sourceType, shop_name: shopName })
      .select('*').single();
    if (error) throw error;
    headerByRef.set(ref, created as DeliveryOrderHeader);
  }

  const headerIds = Array.from(headerByRef.values()).map(h => h.id);

  const { data: allExistingLines } = headerIds.length
    ? await supabase.from('lab_delivery_check_lines')
        .select('id, delivery_order_id, sku, category, product_category, note, qty_expected')
        .in('delivery_order_id', headerIds)
    : { data: [] as any[] };
  const existingLinesByHeader = new Map<string, any[]>();
  for (const l of allExistingLines ?? []) {
    const arr = existingLinesByHeader.get((l as any).delivery_order_id) ?? existingLinesByHeader.set((l as any).delivery_order_id, []).get((l as any).delivery_order_id)!;
    arr.push(l);
  }

  // Shared lookups — fetched ONCE for every order on the page instead of once PER order. This is
  // the single biggest source of redundant reads: neither table varies by order, only by which
  // SKUs happen to be on this page's orders (lab_excluded_skus alone was ~5,000 reads/day, one
  // per order per page view, for a 70-row table that changes maybe monthly).
  const allFicheIds = Array.from(new Set((allOrderLines ?? []).map((l: any) => l.fiche_id).filter(Boolean))) as string[];
  const { data: ficheRows } = allFicheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, category').in('id', allFicheIds)
    : { data: [] as any[] };
  const categoryByFiche: Record<string, string> = {};
  for (const f of ficheRows ?? []) if (f.category) categoryByFiche[f.id] = f.category;

  const allProducibleSkus = Array.from(new Set((allOrderLines ?? []).map((l: any) => l.product_sku).filter(Boolean)));
  const { data: excludedRows } = allProducibleSkus.length
    ? await supabase.from('lab_excluded_skus').select('sku').in('sku', allProducibleSkus)
    : { data: [] as any[] };
  const excludedSkuSet = new Set((excludedRows ?? []).map((r: any) => r.sku));

  // Per-order computation — IDENTICAL logic to ensureDeliveryOrderChecklist (self-heal,
  // exclusion routing, packaging merge), just sourced from the batch-fetched maps above instead
  // of a fresh query per order. Keep in sync with that function if either changes.
  const allToHeal: { id: string; patch: Record<string, any> }[] = [];
  const allToInsert: any[] = [];

  for (const ref of refs) {
    const header = headerByRef.get(ref);
    if (!header) continue;
    const date = dateByRef[ref];
    const orderLines = orderLinesByRef.get(ref) ?? [];
    const packaging = packagingByRef.get(ref) ?? [];
    const existingLines = existingLinesByHeader.get(header.id) ?? [];
    const existingKeys = new Set(existingLines.map((l: any) => `${l.category}||${l.sku}`));

    const bySku: Record<string, { name_vi: string; name_en: string | null; team: string | null; ficheId: string | null; qty: number; notes: Set<string> }> = {};
    for (const l of orderLines) {
      const k = l.product_sku;
      const e = bySku[k] ??= { name_vi: l.product_name_vi, name_en: null, team: l.team, ficheId: l.fiche_id, qty: 0, notes: new Set() };
      e.qty += l.qty;
      if (l.note) e.notes.add(l.note);
    }

    const packagingNoteBySku: Record<string, string> = {};
    const packagingQtyBySku: Record<string, number> = {};
    for (const p of packaging) {
      if (p.note) packagingNoteBySku[p.sku] = p.note;
      packagingQtyBySku[p.sku] = (packagingQtyBySku[p.sku] ?? 0) + p.qty;
    }
    for (const [sku, e] of Object.entries(bySku)) {
      if (excludedSkuSet.has(sku)) packagingQtyBySku[sku] = (packagingQtyBySku[sku] ?? 0) + e.qty;
    }

    for (const el of existingLines) {
      const patch: Record<string, any> = {};
      if (el.category === 'production') {
        const e = bySku[el.sku];
        if (el.sku && excludedSkuSet.has(el.sku)) {
          patch.category = 'packaging'; patch.product_category = 'Packaging'; patch.team = null;
        } else if (!el.product_category) {
          const resolved = e?.ficheId ? categoryByFiche[e.ficheId] : undefined;
          if (resolved) patch.product_category = resolved;
        }
        const computedNote = e?.notes.size ? Array.from(e.notes).join('\n') : null;
        if (computedNote && computedNote !== el.note) patch.note = computedNote;
      } else if (el.category === 'packaging') {
        const computedPkgNote = packagingNoteBySku[el.sku] ?? null;
        if (computedPkgNote && computedPkgNote !== el.note) patch.note = computedPkgNote;
        if (el.sku) {
          const computedQty = packagingQtyBySku[el.sku];
          if (computedQty !== undefined && computedQty !== el.qty_expected) patch.qty_expected = computedQty;
        }
      }
      if (Object.keys(patch).length) allToHeal.push({ id: el.id, patch });
    }

    for (const [sku, e] of Object.entries(bySku)) {
      if (excludedSkuSet.has(sku)) continue;
      const key = `production||${sku}`;
      if (existingKeys.has(key)) continue;
      allToInsert.push({
        delivery_order_id: header.id, delivery_date: date, sku,
        product_name_vi: e.name_vi, product_name_en: e.name_en,
        category: 'production',
        product_category: (e.ficheId && categoryByFiche[e.ficheId]) || 'Autre',
        team: e.team, qty_expected: e.qty,
        note: e.notes.size ? Array.from(e.notes).join('\n') : null,
      });
    }
    const packagingSkus = Array.from(new Set<string>([
      ...packaging.map(p => p.sku),
      ...Object.keys(bySku).filter(sku => excludedSkuSet.has(sku)),
    ]));
    for (const sku of packagingSkus) {
      const key = `packaging||${sku}`;
      if (existingKeys.has(key)) continue;
      const pkgRow = packaging.find(p => p.sku === sku);
      const prodRow = bySku[sku];
      const name = pkgRow?.name ?? prodRow?.name_vi ?? sku;
      const note = pkgRow?.note ?? (prodRow?.notes.size ? Array.from(prodRow.notes).join('\n') : null);
      allToInsert.push({
        delivery_order_id: header.id, delivery_date: date, sku,
        product_name_vi: name, product_name_en: name,
        category: 'packaging', product_category: 'Packaging', team: null,
        qty_expected: packagingQtyBySku[sku] ?? 0,
        note,
      });
    }
  }

  for (const h of allToHeal) {
    const { error: healError } = await supabase.from('lab_delivery_check_lines').update(h.patch).eq('id', h.id);
    if (healError) throw healError;
  }
  if (allToInsert.length) {
    const { error: insertError } = await supabase.from('lab_delivery_check_lines')
      .upsert(allToInsert, { onConflict: 'delivery_order_id,category,sku', ignoreDuplicates: true });
    if (insertError) throw insertError;
  }

  const { data: allFinalLines, error: finalError } = headerIds.length
    ? await supabase.from('lab_delivery_check_lines').select('*').in('delivery_order_id', headerIds)
        .order('category', { ascending: true }).order('product_name_vi', { ascending: true })
    : { data: [] as any[] };
  if (finalError) throw finalError;
  const finalLinesByHeader = new Map<string, CheckLine[]>();
  for (const l of allFinalLines ?? []) {
    const hid = (l as any).delivery_order_id;
    const arr = finalLinesByHeader.get(hid) ?? finalLinesByHeader.set(hid, []).get(hid)!;
    arr.push(l as CheckLine);
  }

  for (const o of orders) {
    const header = headerByRef.get(o.order_ref);
    if (!header) continue;
    result.set(`${o.delivery_date}||${o.order_ref}`, { header, lines: finalLinesByHeader.get(header.id) ?? [] });
  }
  return result;
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
    // Same race-condition fix as ensureDeliveryOrderChecklist above — upsert + ignoreDuplicates
    // against the lab_v39 unique index on manual_cake_id, instead of a plain insert that two
    // concurrent calls could both perform for the same cake.
    const { error: insertError } = await supabase.from('lab_delivery_check_lines')
      .upsert(toInsert, { onConflict: 'manual_cake_id', ignoreDuplicates: true });
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
