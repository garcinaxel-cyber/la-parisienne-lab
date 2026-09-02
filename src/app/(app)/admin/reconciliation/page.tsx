import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import CheckView from './CheckView';

export const revalidate = 0;

// Admin-only control tab (explicitly NOT lab_manager, per Axel — this is a control/audit
// tool over everyone else's work, not an operational one). "Check" (renamed from
// "Réconciliation", 2026-08-20): one button runs all 4 checks at once — reconciliation
// (Odoo demand vs tracked cards), delivery-check coverage, production→stock, stock→Odoo.
// 7-day history (lab_v46 purge cron) — table/route/URL kept as lab_reconciliation_runs /
// /admin/reconciliation on purpose, zero cron or RLS churn for a rename that's UI-only.
export default async function CheckPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  const { data: runs } = await supabase
    .from('lab_reconciliation_runs')
    .select(`
      id, run_at, triggered_by, range_from, range_to, dates_checked, issue_count, issues, error,
      check_range_from, check_range_to,
      delivery_coverage_issues, delivery_coverage_count,
      production_stock_issues, production_stock_count,
      stock_odoo_issues, stock_odoo_count, odoo_volume,
      late_delivery_issues, late_delivery_count,
      safety_stock_issues, safety_stock_count,
      orphan_stock_issues, orphan_stock_count, stock_snapshot
    `)
    .order('run_at', { ascending: false })
    .limit(20);

  // Odoo sync heartbeat (lab_v52) -- single row, admin SELECT policy. Live state, not part of
  // the stored runs: "is the cron alive right now?" rather than "what did the last run find?".
  const { data: hb } = await supabase
    .from('lab_sync_lock')
    .select('last_success_at, last_error_at, last_error')
    .eq('id', true)
    .maybeSingle();

  return <CheckView runs={runs ?? []} heartbeat={hb ?? null} />;
}
