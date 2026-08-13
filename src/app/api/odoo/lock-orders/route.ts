import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured, odooWriteConfigured } from '@/lib/odoo';
import { lockTomorrowOrders } from '@/lib/odoo-order-lock';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// J+1 order auto-lock (announced to the team 2026-08-13, effective 2026-08-14). Called twice
// daily by pg_cron with ?secret=CRON_SECRET — 16h VN (the announced deadline) and 23:59 VN
// (catch-all) — both hitting the exact same "tomorrow" window; see lockTomorrowOrders in
// odoo-order-lock.ts for the full scoping rationale (delivery-date based, not creation-time,
// same-day J deliveries excluded entirely).
//
// ?dryRun=true — reports exactly what WOULD be locked without calling Odoo at all. Use this by
// hand before the first live run (2026-08-14, 16h VN) to sanity-check the order/replenishment
// list, per the safety plan agreed with Axel.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !odooWriteConfigured()) {
    return NextResponse.json({ error: 'ODOO_* / ODOO_WRITE_* not configured' }, { status: 503 });
  }
  const dryRun = url.searchParams.get('dryRun') === 'true';

  try {
    const result = await lockTomorrowOrders(dryRun);
    const allErrors = [...result.salesOrders.errors, ...result.replenishments.errors];
    // Surface failures the same way confirm-mos already does — a lock that silently fails must
    // not just sit there unlocked with no one told.
    if (!dryRun && allErrors.length && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from('lab_odoo_changes').insert({
        order_ref: `lock-orders:${result.date}`,
        cancelled: false,
        items: allErrors.map(e => ({ sku: e.name, name: e.name, reason: e.error })),
        delivery_date: result.date,
        status: 'error',
      });
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Order lock failed' }, { status: 502 });
  }
}
