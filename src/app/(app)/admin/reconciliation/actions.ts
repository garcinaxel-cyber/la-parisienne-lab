'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { runAllChecks } from '@/lib/checks';

// Single "Check" button — admin only (enforced here again, not just in the page's redirect,
// since this is a server action reachable independently of the page render). Runs all 4 checks
// at once (Axel, 2026-08-20: "1 seul bouton check et tout se check automatiquement") — the same
// combined run the daily cron does (src/app/api/odoo/reconciliation-check), just triggered on
// demand instead of on a timer, logging the admin's name instead of 'cron' so the run history
// shows who asked for it.
export async function runCheckNowAction() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Admin only' };

  try {
    const r = await runAllChecks(supabase as any);
    const totalIssues = r.reconciliation.issues.length + r.deliveryCoverage.length + r.productionStock.length + r.stockOdoo.length;
    await supabase.from('lab_reconciliation_runs').insert({
      triggered_by: profile.full_name || 'admin',
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
    });
    revalidatePath('/admin/reconciliation');
    return { ok: true, issueCount: totalIssues };
  } catch (e: any) {
    return { error: e?.message ?? 'Check failed' };
  }
}
