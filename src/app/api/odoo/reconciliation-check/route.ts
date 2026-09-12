import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runAllChecks, type SafetyStockIssue } from '@/lib/checks';
import { sendTeamPush, type PushPayload } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily "Check" cron (called by pg_cron with ?secret=CRON_SECRET — see
// lab_v32_reconciliation.sql for the schedule; URL kept as-is on purpose so no cron edit was
// needed when this was widened from reconciliation-only to all 4 checks, 2026-08-20). Always
// writes exactly one row to lab_reconciliation_runs, even on zero issues — the admin page's
// "last run" timestamp is how the admin knows the check is actually running, not just that it
// once found something. Also callable by hand (no params — runAllChecks owns its own windows).
//
// Safety-stock push to chefs (Axel, 2026-09-12: "je voudrais egalement que les chefs recoivent
// une notification quand un produit en stock passe sous le seuil de securite" — Macaron/Biscuit
// Voyage/Tiramisu only, exactly the 3 categories checkSafetyStock already covers). Deliberately
// reuses THIS run rather than a new, more frequent cron (Axel confirmed 1x/jour à 6h is enough) —
// zero extra Odoo calls. "des que ca passe sous le seuil il y ait une notif, pas plus" (Axel) —
// notify once per crossing, never repeat on a later day the same SKU is still low — tracked via
// lab_safety_stock_alerts (lab_v81): a SKU already in that table is skipped, and one that's back
// at/above threshold today is cleared from it so a later second dip notifies again. Guarded
// behind !r.stockSnapshot.error so a transient Odoo read failure (empty safetyStock as a side
// effect, not a real recovery) never wipes out real alert state.
async function notifySafetyStockDrops(supabase: SupabaseClient, issues: SafetyStockIssue[]): Promise<void> {
  try {
    const { data: alerted } = await supabase.from('lab_safety_stock_alerts').select('sku');
    const alertedSkus = new Set((alerted ?? []).map((r: any) => r.sku as string));
    const currentSkus = new Set(issues.map(i => i.sku));

    const recovered = Array.from(alertedSkus).filter(sku => !currentSkus.has(sku));
    if (recovered.length) await supabase.from('lab_safety_stock_alerts').delete().in('sku', recovered);

    const newlyBelow = issues.filter(i => !alertedSkus.has(i.sku));
    if (!newlyBelow.length) return;

    const byTeam = new Map<string, SafetyStockIssue[]>();
    for (const i of newlyBelow) {
      for (const team of i.teams.length ? i.teams : ['__no_team__']) {
        const list = byTeam.get(team) ?? [];
        list.push(i);
        byTeam.set(team, list);
      }
    }
    for (const [team, items] of Array.from(byTeam.entries())) {
      if (team === '__no_team__') continue; // no team assigned on the fiche — nobody to push to
      const shown = items.slice(0, 4).map(i => `${i.name} (${i.qty}/${i.threshold})`).join(', ');
      const rest = items.length > 4 ? ` +${items.length - 4}` : '';
      const viPayload: PushPayload = { title: 'La Parisienne Lab', body: `⚠️ Dưới ngưỡng an toàn: ${shown}${rest}`, url: `/station/${team}` };
      const enPayload: PushPayload = { title: 'La Parisienne Lab', body: `⚠️ Below safety threshold: ${shown}${rest}`, url: `/station/${team}` };
      await sendTeamPush(supabase, team, viPayload, enPayload);
    }
    await supabase.from('lab_safety_stock_alerts').upsert(
      newlyBelow.map(i => ({ sku: i.sku, category: i.category, qty: i.qty, threshold: i.threshold, notified_at: new Date().toISOString() })),
      { onConflict: 'sku' },
    );
  } catch (e: any) {
    console.error('[reconciliation-check] safety-stock notify failed:', e?.message ?? e);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const r = await runAllChecks(supabase as any);
    const totalIssues = r.reconciliation.issues.length + r.deliveryCoverage.length + r.productionStock.length + r.stockOdoo.length + r.lateDeliveries.filter(i => !i.doneOnOdoo).length + r.safetyStock.length + r.orphanStock.length;
    await supabase.from('lab_reconciliation_runs').insert({
      triggered_by: 'cron',
      range_from: r.reconciliation.rangeFrom,
      range_to: r.reconciliation.rangeTo,
      dates_checked: r.reconciliation.datesChecked,
      issue_count: r.reconciliation.issues.length,
      issues: r.reconciliation.issues,
      check_range_from: r.checkRangeFrom,
      check_range_to: r.checkRangeTo,
      delivery_coverage_issues: r.deliveryCoverage,
      delivery_coverage_count: r.deliveryCoverage.length,
      production_stock_issues: r.productionStock,
      production_stock_count: r.productionStock.length,
      stock_odoo_issues: r.stockOdoo,
      stock_odoo_count: r.stockOdoo.length,
      odoo_volume: r.odooVolume,
      late_delivery_issues: r.lateDeliveries,
      late_delivery_count: r.lateDeliveries.filter(i => !i.doneOnOdoo).length,
      safety_stock_issues: r.safetyStock,
      safety_stock_count: r.safetyStock.length,
      orphan_stock_issues: r.orphanStock,
      orphan_stock_count: r.orphanStock.length,
      stock_snapshot: r.stockSnapshot,
    });
    if (!r.stockSnapshot.error) await notifySafetyStockDrops(supabase, r.safetyStock);
    return NextResponse.json({ ok: true, issue_count: totalIssues });
  } catch (e: any) {
    const msg = e?.message ?? 'Check failed';
    const today = new Date().toISOString().split('T')[0];
    await supabase.from('lab_reconciliation_runs').insert({
      triggered_by: 'cron',
      range_from: today, range_to: today, dates_checked: 0, issue_count: 0, issues: [],
      check_range_from: today, check_range_to: today,
      error: msg,
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
