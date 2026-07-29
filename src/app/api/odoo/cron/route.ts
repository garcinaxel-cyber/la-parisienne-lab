import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured } from '@/lib/odoo';
import { runAutoOdooSync } from '@/lib/odoo-auto-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Every-15-min auto-sync (called by pg_cron / external scheduler with ?secret=CRON_SECRET).
// AUTO mode: the app mirrors Odoo for today's and upcoming orders without a manual publish step.
//  - New orders are imported as PUBLISHED → the chefs see them immediately.
//  - Modifications & cancellations are auto-applied — qty adjusted, cancelled orders struck
//    through, produced quantities never erased.
// The actual work lives in runAutoOdooSync (shared with the on-demand "Sync Odoo" button on
// the station pages — same behaviour, just triggered by a chef instead of the clock).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (ODOO_* / SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const result = await runAutoOdooSync(supabase as any);
    if (result.error) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Cron sync failed' }, { status: 502 });
  }
}
