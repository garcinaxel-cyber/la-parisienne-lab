import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runReconciliationCheck } from '@/lib/reconciliation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily reconciliation cron (called by pg_cron with ?secret=CRON_SECRET — see
// lab_v32_reconciliation.sql). Also callable by hand with ?from=YYYY-MM-DD&to=YYYY-MM-DD.
// Always writes exactly one row to lab_reconciliation_runs, even on zero issues — the
// admin page's "last run" timestamp is how the admin knows the check is actually running,
// not just that it once found something.
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
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;

  try {
    const result = await runReconciliationCheck(supabase as any, { from, to });
    await supabase.from('lab_reconciliation_runs').insert({
      triggered_by: 'cron',
      range_from: result.rangeFrom,
      range_to: result.rangeTo,
      dates_checked: result.datesChecked,
      issue_count: result.issues.length,
      issues: result.issues,
    });
    return NextResponse.json({ ok: true, issue_count: result.issues.length, dates_checked: result.datesChecked });
  } catch (e: any) {
    const msg = e?.message ?? 'Reconciliation check failed';
    await supabase.from('lab_reconciliation_runs').insert({
      triggered_by: 'cron',
      range_from: from ?? new Date().toISOString().split('T')[0],
      range_to: to ?? new Date().toISOString().split('T')[0],
      dates_checked: 0,
      issue_count: 0,
      issues: [],
      error: msg,
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
