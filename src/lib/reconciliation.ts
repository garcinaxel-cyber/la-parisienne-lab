import type { SupabaseClient } from '@supabase/supabase-js';
import { TEAMS } from '@/lib/types';
import { getManualCakeCoverage, excessQty } from '@/lib/manual-cake-coverage';

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

// One date at a time — mirrors the exact computation already proven correct in
// orders/[date]/page.tsx's "missingCards" detector, generalized to also flag the reverse
// (over-tracked) case and aggregated across the whole day instead of per-import.
async function checkOneDate(supabase: SupabaseClient, date: string): Promise<ReconciliationIssue[]> {
  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id')
    .eq('delivery_date', date)
    .eq('status', 'published')
    .neq('notes', '__manual_cakes__');
  const importIds = (imports ?? []).map((i: any) => i.id);
  if (!importIds.length) return [];

  const [{ data: orderLines }, { data: assignments }] = await Promise.all([
    supabase.from('lab_order_lines')
      .select('import_id, product_sku, product_name_vi, qty, order_ref')
      .in('import_id', importIds),
    supabase.from('lab_assignments')
      .select('team, variant_label, product_name_vi, total_qty, cancelled')
      .in('import_id', importIds),
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
  for (const l of orderLines ?? []) {
    const v = l.product_sku ? variantBySku.get(l.product_sku) : null;
    if (!v) continue;
    const team = ficheTeams.get(v.fiche_id) ?? '';
    if (!TEAMS.includes(team as any)) continue;
    const needed = (l.order_ref && l.product_sku)
      ? excessQty(coverage, l.order_ref, l.product_sku, date, l.qty ?? 0)
      : (l.qty ?? 0);
    if (needed <= 0) continue;
    const key = `${team}||${v.label}||${l.product_name_vi}`;
    const cur = neededByKey.get(key) ?? { team, variantLabel: v.label, name: l.product_name_vi, total: 0 };
    cur.total += needed;
    neededByKey.set(key, cur);
  }

  const trackedByKey = new Map<string, { team: string; variantLabel: string; name: string; total: number }>();
  for (const a of assignments ?? []) {
    if (a.cancelled) continue;
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
