import { NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { pushDueChefLosses } from '@/lib/chef-losses';

// Chef losses (Axel, 2026-11-12): a loss still not validated after its lab day goes to Odoo anyway
// ("si le chef n'a pas validé alors on pousse la perte"), and any validated loss whose Odoo push
// failed is retried. Vercel cron, Authorization: Bearer CRON_SECRET.
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });
  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const res = await pushDueChefLosses(db, 100_000);
  console.log('[chef-losses-push]', JSON.stringify(res));
  return NextResponse.json(res, { status: res.errors.length ? 207 : 200 });
}
