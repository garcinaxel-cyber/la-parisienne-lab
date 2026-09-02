'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { runAllChecks } from '@/lib/checks';
import { syncStockToOdoo } from '@/lib/odoo-mo-sync';
import { odooWriteConfigured } from '@/lib/odoo';

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
    const totalIssues = r.reconciliation.issues.length + r.deliveryCoverage.length + r.productionStock.length + r.stockOdoo.length + r.lateDeliveries.length + r.safetyStock.length + r.orphanStock.length;
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
      odoo_volume: r.odooVolume,
      late_delivery_issues: r.lateDeliveries,
      late_delivery_count: r.lateDeliveries.length,
      safety_stock_issues: r.safetyStock,
      safety_stock_count: r.safetyStock.length,
      orphan_stock_issues: r.orphanStock,
      orphan_stock_count: r.orphanStock.length,
      stock_snapshot: r.stockSnapshot,
    });
    revalidatePath('/admin/reconciliation');
    return { ok: true, issueCount: totalIssues };
  } catch (e: any) {
    return { error: e?.message ?? 'Check failed' };
  }
}

// "Create MO" button on a Stock -> Odoo check issue (CheckView.tsx) -- reuses the exact same
// sync engine as the real-time trigger (stock-actions.ts) and the old production-history manual
// resync, scoped to just the one SKU/day the admin clicked on. Admin only, same as the rest of
// this page. (Axel, 2026-09-01: the real-time sync can fail with zero trace anywhere -- see
// BMCRDT/BMCRS on 2026-09-01, no lab_odoo_changes row, no Vercel error, MO just never created --
// so a manual one-click fix now lives on the page that actually surfaces the gap, replacing the
// old production-history tab's version of this same button.)
export async function fixStockOdooIssueAction(date: string, sku: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Admin only' };
  if (!odooWriteConfigured()) return { error: 'ODOO_WRITE_* not configured -- cannot create MOs' };

  try {
    const r = await syncStockToOdoo(supabase, date, { commit: true, skus: [sku] });
    if (r.errors?.length) return { error: r.errors.map(e => e.error).join('; ') };
    return { ok: true };
  } catch (e: any) {
    return { error: e?.message ?? 'Sync failed' };
  }
}
