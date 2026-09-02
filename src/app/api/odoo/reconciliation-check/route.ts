import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAllChecks } from '@/lib/checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily "Check" cron (called by pg_cron with ?secret=CRON_SECRET — see
// lab_v32_reconciliation.sql for the schedule; URL kept as-is on purpose so no cron edit was
// needed when this was widened from reconciliation-only to all 4 checks, 2026-08-20). Always
// writes exactly one row to lab_reconciliation_runs, even on zero issues — the admin page's
// "last run" timestamp is how the admin knows the check is actually running, not just that it
// once found something. Also callable by hand (no params — runAllChecks owns its own windows).
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
