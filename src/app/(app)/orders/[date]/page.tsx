import { createClient } from '@/lib/supabase-server';
import OrdersTabs from './OrdersTabs';
import { getManualCakeCoverage, excessQty } from '@/lib/manual-cake-coverage';

export const revalidate = 0; // always fresh — a just-imported/saved order must appear immediately

export default async function OrderDatePage({ params }: { params: { date: string } }) {
  const supabase = createClient();
  const { date } = params;

  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id, delivery_date, order_number, type, status, shipped_from_lab, notes, imported_at, published_at, published_by_name, control_report')
    .eq('delivery_date', date)
    .neq('notes', '__manual_cakes__') // hide the internal manual-cakes container
    .order('order_number');

  const importIds = (imports ?? []).map((i: any) => i.id);

  const [assignmentsResult, orderLinesResult, userResult] = await Promise.all([
    importIds.length > 0
      ? supabase
          .from('lab_assignments')
          .select(`
            id, team, product_name_vi, product_name_en, image_url,
            variant_label, total_qty, qty_to_produce, qty_produced,
            status, exception_reason, notes, sort_order, import_id, cancelled
          `)
          .in('import_id', importIds)
          .order('team').order('sort_order')
      : Promise.resolve({ data: [] }),
    // lab_order_lines is used for per-client breakdown display (managers can read it)
    importIds.length > 0
      ? supabase
          .from('lab_order_lines')
          .select('import_id, team, variant_label, shop_name, qty, order_ref, product_sku, product_name_vi, delivery_time, source_type, note, published, published_by_name')
          .in('import_id', importIds)
          .order('shop_name')
      : Promise.resolve({ data: [] }),
        supabase.auth.getSession(),
  ]);

  // Fetch breakdown separately (requires lab_v3.sql — safe fallback if not run)
  const assignmentIds = (assignmentsResult.data ?? []).map((a: any) => a.id);
  const { data: breakdowns } = assignmentIds.length > 0
    ? await supabase.from('lab_assignments').select('id, breakdown').in('id', assignmentIds)
    : { data: [] as any[] };
  const breakdownMap: Record<string, any[]> = {};
  for (const b of breakdowns ?? []) breakdownMap[b.id] = Array.isArray(b.breakdown) ? b.breakdown : [];

  const assignments = (assignmentsResult.data ?? []).map((a: any) => ({
    ...a, breakdown: breakdownMap[a.id] ?? [],
  }));

  // Products in the orders that have NO lab fiche → they won't become production cards.
  // Surface them in the publish bar so the assistant can create a fiche or exclude them.
  const orderLineSkus = Array.from(new Set(
    (orderLinesResult.data ?? []).map((l: any) => l.product_sku).filter(Boolean)
  )) as string[];
  const { data: matchedVariants } = orderLineSkus.length > 0
    ? await supabase.from('lab_fiche_variants').select('sku').in('sku', orderLineSkus)
    : { data: [] as any[] };
  const matchedSkuSet = new Set((matchedVariants ?? []).map((v: any) => v.sku));
  // SKUs permanently marked "not produced" (packaging, drinks…) — never warn about them
  const { data: excludedRows } = orderLineSkus.length > 0
    ? await supabase.from('lab_excluded_skus').select('sku').in('sku', orderLineSkus)
    : { data: [] as any[] };
  const excludedSkuSet = new Set((excludedRows ?? []).map((r: any) => r.sku));
  const unmatchedMap = new Map<string, { sku: string; name: string; qty: number }>();
  for (const l of orderLinesResult.data ?? []) {
    if (!l.product_sku || matchedSkuSet.has(l.product_sku) || excludedSkuSet.has(l.product_sku)) continue;
    const cur = unmatchedMap.get(l.product_sku) ?? { sku: l.product_sku, name: l.product_name_vi ?? l.product_sku, qty: 0 };
    cur.qty += l.qty ?? 0;
    unmatchedMap.set(l.product_sku, cur);
  }
  const unmatchedProducts = Array.from(unmatchedMap.values());

  // Missing cards: order lines whose demand (Odoo qty minus whatever a manual cake already
  // covers, see manual-cake-coverage.ts) isn't fully tracked by an existing card yet — either
  // because a fiche was added after publish, or because the sync's card only covers the excess
  // over a matched manual cake and a further increase hasn't been picked up. Matched by
  // team+variant+name+order_ref (not scoped to one import_id), so a card living under a
  // different import (e.g. a legacy same-day-merged one) still counts as coverage.
  const publishedImportIds = new Set((imports ?? []).filter((i: any) => i.status === 'published').map((i: any) => i.id));
  const coveredByBreakdown = new Map<string, number>();
  for (const a of assignments) {
    if (a.cancelled) continue;
    for (const b of Array.isArray(a.breakdown) ? a.breakdown : []) {
      if (!b?.order_ref) continue;
      const k = `${a.team}||${a.variant_label}||${a.product_name_vi}||${b.order_ref}`;
      coveredByBreakdown.set(k, (coveredByBreakdown.get(k) ?? 0) + (b.qty ?? 0));
    }
  }
  const variantBySkuForMissing = new Map<string, { label: string; fiche_id: string }>();
  if (orderLineSkus.length > 0) {
    const { data: vfull } = await supabase.from('lab_fiche_variants').select('sku, label, fiche_id').in('sku', orderLineSkus);
    for (const v of vfull ?? []) if (v.sku) variantBySkuForMissing.set(v.sku, { label: v.label ?? 'Standard', fiche_id: v.fiche_id });
  }
  const ficheTeams = new Map<string, string>();
  {
    const fids = Array.from(new Set(Array.from(variantBySkuForMissing.values()).map(v => v.fiche_id)));
    if (fids.length) {
      const { data: fm } = await supabase.from('lab_fiche_meta').select('id, teams').in('id', fids);
      for (const f of fm ?? []) ficheTeams.set(f.id, (f.teams ?? [])[0] ?? '');
    }
  }
  // Manual-cake coverage for this date (unmatched → whole SKU excluded; matched → capped at the
  // cake's own qty, per order_ref — see manual-cake-coverage.ts). Also still needed below (Phase
  // 3 duplicate-detection UI), so keep fetching the raw rows too.
  const { data: manualCakesForDate } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, matched_order_ref, product_name_vi, qty, needs_odoo, rejected_order_refs, shop_name, created_by_name')
    .eq('delivery_date', date);
  const coverage = await getManualCakeCoverage(supabase, date);

  const missingMap = new Map<string, { name: string; team: string; qty: number }>();
  for (const l of orderLinesResult.data ?? []) {
    if (!publishedImportIds.has(l.import_id)) continue;
    const v = l.product_sku ? variantBySkuForMissing.get(l.product_sku) : null;
    if (!v) continue;
    const team = ficheTeams.get(v.fiche_id) ?? '';
    if (!['baby_mama', 'hung', 'entremet', 'baker'].includes(team)) continue;
    const needed = (l.order_ref && l.product_sku)
      ? excessQty(coverage, l.order_ref, l.product_sku, date, l.qty ?? 0)
      : (l.qty ?? 0);
    if (needed <= 0) continue; // fully covered by a manual cake
    const tracked = l.order_ref ? (coveredByBreakdown.get(`${team}||${v.label}||${l.product_name_vi}||${l.order_ref}`) ?? 0) : 0;
    const gap = needed - tracked;
    if (gap <= 0) continue; // an existing card already covers this order's demand
    const key = `${l.import_id}||${team}||${v.label}||${l.product_name_vi}`;
    const cur = missingMap.get(key) ?? { name: l.product_name_vi, team, qty: 0 };
    cur.qty += gap;
    missingMap.set(key, cur);
  }
  const missingCards = Array.from(missingMap.values());
  const missingCardsCount = missingCards.length;

    const profile = userResult.data.session
        ? (await supabase.from('profiles').select('role').eq('id', userResult.data.session.user.id).single()).data
    : null;

  // Odoo order lines whose cake is actually made via a linked manual cake — used by the UI
  // to badge that order line ("produced via manual cake"), independent of the card-coverage
  // math above.
  const producedManually = Array.from(new Set((manualCakesForDate ?? []).filter((m: any) => m.matched_order_ref).map((m: any) => `${m.matched_order_ref}||${m.product_sku}`)));

  // Phase 3 — duplicate detection AT publication time: manual orders of this day still
  // to be entered in Odoo, with a suggested match among THIS day's order lines
  // (same SKU, previously rejected refs excluded). Confirmed here = same effect as
  // confirming from the exceptional-orders page (production never doubled).
  const openManual = (manualCakesForDate ?? []).filter((m: any) => m.needs_odoo && !m.matched_order_ref);
  const manualMatches = openManual.flatMap((m: any) => {
    if (!m.product_sku) return [];
    const rejected = new Set<string>(m.rejected_order_refs ?? []);
    const seen = new Set<string>();
    const cands: { ref: string; shop: string | null }[] = [];
    for (const l of orderLinesResult.data ?? []) {
      if (l.product_sku !== m.product_sku || !l.order_ref) continue;
      if (rejected.has(l.order_ref) || seen.has(l.order_ref)) continue;
      seen.add(l.order_ref);
      cands.push({ ref: l.order_ref, shop: l.shop_name ?? null });
    }
    if (!cands.length) return [];
    return [{
      manualId: m.id as string,
      name: (m.product_name_vi ?? m.product_sku) as string,
      qty: m.qty as number,
      sku: m.product_sku as string,
      source: (m.shop_name ?? m.created_by_name ?? '') as string,
      fromShop: !!m.shop_name,
      suggestedRef: cands[0].ref,
      suggestedShop: cands[0].shop,
    }];
  });
  const openManualNoMatch = openManual.length - manualMatches.length;

  return (
    <OrdersTabs
      date={date}
      imports={imports ?? []}
      assignments={assignments}
      orderLines={orderLinesResult.data ?? []}
      unmatchedProducts={unmatchedProducts}
      missingCardsCount={missingCardsCount}
      missingCards={missingCards}
      producedManually={producedManually}
      manualMatches={manualMatches}
      openManualNoMatch={openManualNoMatch}
      userRole={profile?.role ?? null}
    />
  );
}
