import { createClient } from '@/lib/supabase-server';
import OrdersTabs from './OrdersTabs';

export const revalidate = 30;

export default async function OrderDatePage({ params }: { params: { date: string } }) {
  const supabase = createClient();
  const { date } = params;

  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id, delivery_date, order_number, type, status, shipped_from_lab, notes, imported_at, published_at, control_report')
    .eq('delivery_date', date)
    .order('order_number');

  const importIds = (imports ?? []).map((i: any) => i.id);

  const [assignmentsResult, orderLinesResult, userResult] = await Promise.all([
    importIds.length > 0
      ? supabase
          .from('lab_assignments')
          .select(`
            id, team, product_name_vi, product_name_en, image_url,
            variant_label, total_qty, qty_to_produce, qty_produced,
            status, exception_reason, notes, sort_order, import_id
          `)
          .in('import_id', importIds)
          .order('team').order('sort_order')
      : Promise.resolve({ data: [] }),
    // lab_order_lines is used for per-client breakdown display (managers can read it)
    importIds.length > 0
      ? supabase
          .from('lab_order_lines')
          .select('import_id, team, variant_label, shop_name, qty, order_ref, product_sku, product_name_vi, delivery_time, source_type, note')
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

  // Missing cards: order lines that HAVE a fiche now but no production card yet
  // (fiche added after the import was published). Count them for the "generate" button.
  const asgKeys = new Set(
    (assignmentsResult.data ?? []).map((a: any) => `${a.import_id}||${a.team}||${a.variant_label}||${a.product_name_vi}`)
  );
  const publishedImportIds = new Set((imports ?? []).filter((i: any) => i.status === 'published').map((i: any) => i.id));
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
  const missingMap = new Map<string, { name: string; team: string; qty: number }>();
  for (const l of orderLinesResult.data ?? []) {
    if (!publishedImportIds.has(l.import_id)) continue;
    const v = l.product_sku ? variantBySkuForMissing.get(l.product_sku) : null;
    if (!v) continue;
    const team = ficheTeams.get(v.fiche_id) ?? '';
    if (!['baby_mama', 'hung', 'entremet', 'baker'].includes(team)) continue;
    const key = `${l.import_id}||${team}||${v.label}||${l.product_name_vi}`;
    if (asgKeys.has(key)) continue;
    const cur = missingMap.get(key) ?? { name: l.product_name_vi, team, qty: 0 };
    cur.qty += l.qty ?? 0;
    missingMap.set(key, cur);
  }
  const missingCards = Array.from(missingMap.values());
  const missingCardsCount = missingCards.length;

    const profile = userResult.data.session
        ? (await supabase.from('profiles').select('role').eq('id', userResult.data.session.user.id).single()).data
    : null;

  return (
    <OrdersTabs
      date={date}
      imports={imports ?? []}
      assignments={assignments}
      orderLines={orderLinesResult.data ?? []}
      unmatchedProducts={unmatchedProducts}
      missingCardsCount={missingCardsCount}
      missingCards={missingCards}
      userRole={profile?.role ?? null}
    />
  );
}
