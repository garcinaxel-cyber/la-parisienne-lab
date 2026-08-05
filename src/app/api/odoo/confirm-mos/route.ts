import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured, odooWriteConfigured, labDateOf } from '@/lib/odoo';
import { confirmDoneMOs } from '@/lib/odoo-mo-confirm';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily confirmation of the lab-day's remaining draft MOs (called by pg_cron with
// ?secret=CRON_SECRET — see lab_v30_mo_confirm_cron.sql — once the hourly sync's active window
// closes for the day). Also callable by hand with an explicit ?date=YYYY-MM-DD for catch-up.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !odooWriteConfigured()) {
    return NextResponse.json({ error: 'ODOO_* / ODOO_WRITE_* not configured' }, { status: 503 });
  }
  const date = url.searchParams.get('date') || labDateOf(new Date().toISOString())!;

  try {
    const result = await confirmDoneMOs(date);
    // Surface failures the same way the rest of the Odoo sync already does (odoo-auto-sync.ts,
    // stock-actions.ts) — a confirm that silently fails must not just sit there unconfirmed with
    // no one told.
    if (result.errors.length && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from('lab_odoo_changes').insert({
        order_ref: `mo-confirm:${date}`,
        cancelled: false,
        items: result.errors.map(e => ({ sku: e.name, name: e.name, reason: e.error })),
        delivery_date: date,
        status: 'error',
      });
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'MO confirm failed' }, { status: 502 });
  }
}
