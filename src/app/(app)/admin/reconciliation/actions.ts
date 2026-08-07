'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { runReconciliationCheck } from '@/lib/reconciliation';

// Manual "Lancer le contrôle maintenant" button — admin only (enforced here again, not just
// in the page's redirect, since this is a server action reachable independently of the page
// render). Runs the exact same check as the daily cron (src/app/api/odoo/reconciliation-check),
// just triggered on demand instead of on a timer, and logs the admin's name instead of 'cron'
// so the run history shows who asked for it.
export async function runReconciliationNowAction() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Admin only' };

  try {
    const result = await runReconciliationCheck(supabase as any);
    await supabase.from('lab_reconciliation_runs').insert({
      triggered_by: profile.full_name || 'admin',
      range_from: result.rangeFrom,
      range_to: result.rangeTo,
      dates_checked: result.datesChecked,
      issue_count: result.issues.length,
      issues: result.issues,
    });
    revalidatePath('/admin/reconciliation');
    return { ok: true, issueCount: result.issues.length };
  } catch (e: any) {
    return { error: e?.message ?? 'Reconciliation check failed' };
  }
}
