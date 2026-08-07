import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ReconciliationView from './ReconciliationView';

export const revalidate = 0;

// Admin-only control tab (explicitly NOT lab_manager, per Axel — this is a control/audit
// tool over everyone else's work, not an operational one). Shows the daily reconciliation
// cron's run history + a manual "run now" button (actions.ts).
export default async function ReconciliationPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  const { data: runs } = await supabase
    .from('lab_reconciliation_runs')
    .select('id, run_at, triggered_by, range_from, range_to, dates_checked, issue_count, issues, error')
    .order('run_at', { ascending: false })
    .limit(20);

  return <ReconciliationView runs={runs ?? []} />;
}
