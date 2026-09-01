import type { SupabaseClient } from '@supabase/supabase-js';
import { TEAMS } from '@/lib/types';
import { getManualCakeCoverage } from '@/lib/manual-cake-coverage';
import { fetchAllPages } from '@/lib/fetch-all-pages';

// Daily reconciliation — a second, independent check on top of the sync's own change
// detection (odoo-sync.ts / odoo-apply.ts). Where the sync only reacts to a DIFF it just
// saw come back from Odoo, this recomputes from scratch, for a window of dates, what the
// TRUE demand is (Odoo order lines, minus whatever a manual/birthday cake already covers —
// same manual-cake-coverage.ts math already trusted by the "missing card" banner on
// orders/[date]/page.tsx) and compares it to what's actually tracked in lab_assignments.
// Two directions of drift, both real incidents seen in prod:
//  - under-tracked ("manque"): demand exists with no card covering it — same case the
//    existing missing-card banner already catches per date, surfaced here too for a
//    cross-date admin view.
//  - over-tracked ("doublon"): more is tracked than any real demand justifies — this is
//    the NEW check. Nothing else in the app catches this; it's exactly the shape of the
//    2026-08-07 finger-cake duplicate-card incident (fixed by hand in the database that
//    day — see [[lab-app-audit-2026-08-07]]), which this check exists to catch automatically
//    going forward instead of relying on someone noticing.
export interface ReconciliationIssue {
  date: string;
  team: string;
  variantLabel: string;
  name: string;
  needed: number;
  tracked: number;
  gap: number; // tracked - needed. Positive = over-tracked (doublon). Negative = under-tracked (manque).
}

export interface ReconciliationResult {
  rangeFrom: string;
  rangeTo: string;
  datesChecked: number;
  issues: ReconciliationIssue[];
}

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

// One date at a time — starts from the same building blocks as orders/[date]/page.tsx's
// "missingCards" detector (variant/team resolution, manual-cake coverage) but the coverage
// math itself is intentionally NOT reused as-is: excessQty()/pendingSkuDates is a deliberate
// all-or-nothing simplification ("an unmatched manual cake covers ANY demand for that
// sku+date") that's safe for a detector that only ever adds missing-card gaps, but produces
// mass false positives here, where the very same rule would make a genuinely separate, already
// correctly-tracked Odoo order look "over-tracked" just because an unrelated manual cake for
// the same product exists that day (found live 2026-08-07 testing this check: BMGM had a
// 2-unit pending manual cake AND a real, correct 20-unit Odoo replenishment card — the blanket
// rule zeroed out the whole 20 as "needed", flagging a false doublon). Instead: matched manual
// cakes still subtract precisely (coveredByRefSku, scoped to their own order_ref+sku+date —
// this part IS precise and reused as-is), and a PENDING manual cake's own qty is added to
// "needed" via its own linked card (assignment_id) instead of suppressing unrelated demand.
async function checkOneDate(supabase: SupabaseClient, date: string): Promise<ReconciliationIssue[]> {
  // Include the manual-cakes container import too (excluded from the UI's per-date import
  // list, but its cards are real tracked production and must be visible on the "tracked" side
  // — otherwise a manual cake's own card is invisible here and always looks over-tracked).
  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id')
    .eq('delivery_date', date)
    .eq('status', 'published');
  const importIds = (imports ?? []).map((i: any) => i.id);
  if (!importIds.length) return [];

  // Paginated (2026-09-01): these are the same two tables/shapes that already hit the silent
  // 1000-row PostgREST cap in checks.ts (2026-08-20) and the station History badge (2026-09-01).
  // A single busy delivery date is already at ~380 order lines and growing; one large day would
  // have silently dropped rows here and reported phantom "manque" gaps. Ordered by id so the
  // pages are stable under concurrent writes.
  const [orderLines, assignments] = await Promise.all([
    fetchAllPages<any>((f, t) => supabase.from('lab_order_lines')
      .select('import_id, product_sku, product_name_vi, qty, order_ref')
      .in('import_id', importIds).order('id').range(f, t)),
    fetchAllPages<any>((f, t) => supabase.from('lab_assignments')
      .select('id, team, variant_label, product_name_vi, total_qty, cancelled, is_extra')
      .in('import_id', importIds).order('id').range(f, t)),
  ]);

  const orderLineSkus = Array.from(new Set((orderLines ?? []).map((l: any) => l.product_sku).filter(Boolean))) as string[];
  const variantBySku = new Map<string, { label: string; fiche_id: string }>();
  if (orderLineSkus.length > 0) {
    const { data: vfull } = await supabase.from('lab_fiche_variants').select('sku, label, fiche_id').in('sku', orderLineSkus);
    for (const v of vfull ?? []) if (v.sku) variantBySku.set(v.sku, { label: v.label ?? 'Standard', fiche_id: v.fiche_id });
  }
  const ficheTeams = new Map<string, string>();
  {
    const fids = Array.from(new Set(Array.from(variantBySku.values()).map(v => v.fiche_id)));
    if (fids.length) {
      const { data: fm } = await supabase.from('lab_fiche_meta').select('id, teams').in('id', fids);
      for (const f of fm ?? []) ficheTeams.set(f.id, (f.teams ?? [])[0] ?? '');
    }
  }

  const coverage = await getManualCakeCoverage(supabase, date);

  const neededByKey = new Map<string, { team: string; variantLabel: string; name: string; total: number }>();
  const addNeeded = (team: string, variantLabel: string, name: string, qty: number) => {
    if (qty <= 0) return;
    const key = `${team}||${variantLabel}||${name}`;
    const cur = neededByKey.get(key) ?? { team, variantLabel, name, total: 0 };
    cur.total += qty;
    neededByKey.set(key, cur);
  };

  for (const l of orderLines ?? []) {
    const v = l.product_sku ? variantBySku.get(l.product_sku) : null;
    if (!v) continue;
    const team = ficheTeams.get(v.fiche_id) ?? '';
    if (!TEAMS.includes(team as any)) continue;
    // Precise, scoped subtraction — only what a MATCHED manual cake actually covers on this
    // exact order_ref+sku+date. No blanket "any pending cake covers everything" rule.
    const covered = (l.order_ref && l.product_sku)
      ? (coverage.coveredByRefSku.get(`${l.order_ref}||${l.product_sku}||${date}`) ?? 0)
      : 0;
    addNeeded(team, v.label, l.product_name_vi, Math.max(0, (l.qty ?? 0) - covered));
  }

  // Every non-cancelled manual cake (matched OR still pending) is real demand for its own
  // qty — matched or not. Matched ones already have their corresponding order line's
  // contribution reduced above (coveredByRefSku), so without adding the cake's own qty back
  // here, that demand would vanish from "needed" entirely while its card still shows up on
  // "tracked" (false doublon — found live testing this check on a matched cake, S03099 /
  // mini cake Xoài: order-line side correctly went to 0 via coverage, but nothing credited
  // the manual cake's own real 1-unit card). Matched their own card's team/variant/name via
  // assignment_id so it reconciles exactly against its own tracked entry below, instead of
  // guessing team/variant independently.
  const { data: dayCakes } = await supabase
    .from('lab_manual_cakes')
    .select('assignment_id, qty')
    .eq('delivery_date', date)
    .is('cancelled_at', null);
  const asgIds = (dayCakes ?? []).map((m: any) => m.assignment_id).filter(Boolean) as string[];
  const asgInfoById = new Map<string, { team: string; variant_label: string; product_name_vi: string }>();
  for (const a of assignments ?? []) if (asgIds.includes((a as any).id)) asgInfoById.set((a as any).id, a as any);
  for (const m of dayCakes ?? []) {
    if (!m.assignment_id) continue;
    const info = asgInfoById.get(m.assignment_id);
    if (!info || !TEAMS.includes(info.team as any)) continue;
    addNeeded(info.team, info.variant_label, info.product_name_vi, m.qty ?? 0);
  }

  const trackedByKey = new Map<string, { team: string; variantLabel: string; name: string; total: number }>();
  for (const a of assignments ?? []) {
    if (a.cancelled) continue;
    if (a.is_extra) continue; // chef-added buffer stock, never tied to an order — not a reconciliation target
    if (!TEAMS.includes(a.team as any)) continue;
    const key = `${a.team}||${a.variant_label}||${a.product_name_vi}`;
    const cur = trackedByKey.get(key) ?? { team: a.team, variantLabel: a.variant_label, name: a.product_name_vi, total: 0 };
    cur.total += a.total_qty ?? 0;
    trackedByKey.set(key, cur);
  }

  const issues: ReconciliationIssue[] = [];
  const allKeys = new Set(Array.from(neededByKey.keys()).concat(Array.from(trackedByKey.keys())));
  for (const key of Array.from(allKeys)) {
    const needed = neededByKey.get(key)?.total ?? 0;
    const tracked = trackedByKey.get(key)?.total ?? 0;
    const gap = tracked - needed;
    if (gap === 0) continue;
    const src = trackedByKey.get(key) ?? neededByKey.get(key)!;
    issues.push({ date, team: src.team, variantLabel: src.variantLabel, name: src.name, needed, tracked, gap });
  }
  return issues;
}

// Default window: from yesterday (catch a very recent drift not yet corrected) through 6
// days ahead (everything currently plannable). Past-produced days are intentionally left
// alone — see the 2026-08-07 "ne pas fausser la réalité" incident: once a day is produced,
// its historical Odoo-vs-app snapshot is expected to drift as Odoo continues to change, and
// that's not a bug to flag.
export async function runReconciliationCheck(
  supabase: SupabaseClient,
  opts?: { from?: string; to?: string }
): Promise<ReconciliationResult> {
  const today = new Date();
  const from = opts?.from ?? toDateStr(new Date(today.getTime() - 86400000));
  const to = opts?.to ?? toDateStr(new Date(today.getTime() + 6 * 86400000));

  const dates: string[] = [];
  const cursor = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cursor <= end) {
    dates.push(toDateStr(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const issues: ReconciliationIssue[] = [];
  for (const date of dates) {
    issues.push(...(await checkOneDate(supabase, date)));
  }

  return { rangeFrom: from, rangeTo: to, datesChecked: dates.length, issues };
}
