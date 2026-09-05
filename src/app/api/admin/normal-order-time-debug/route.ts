import { NextResponse } from 'next/server';
import { odooConfigured, odooExecute, odooDateTimeToLocal } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// Read-only diagnostic (2026-09-05, Axel: report stat request — "le taux de commande normal
// placé après 14h", i.e. the NORMAL shop order flow, as opposed to lab_manual_cakes'
// exceptional/manual orders already covered by a Supabase query). Normal shop demand for the
// 4 La Paris retail branches goes through stock.replenishment.request, not sale.order (see
// odoo-sync.ts's SALES_ORDER_EXCLUDED_SHOP_SUBSTRINGS comment) — create_date isn't mirrored
// into Supabase anywhere, so this reads it straight from Odoo. Same CRON_SECRET pattern as the
// other one-off /api/admin/*-debug routes: narrow, single-purpose, secret-gated, READ-ONLY,
// called by hand via curl, no session.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) {
    return NextResponse.json({ error: 'ODOO_* not configured' }, { status: 503 });
  }

  try {
    const since = url.searchParams.get('since') ?? '2026-07-15 00:00:00';
    const cutoffHour = Number(url.searchParams.get('cutoff') ?? '14');

    const repls = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
      [[['create_date', '>=', since], ['state', '!=', 'cancel']]],
      { fields: ['name', 'create_date', 'delivery_date', 'state', 'warehouse_id'], limit: 2000 });

    const rows = repls.map((r: any) => {
      const local = odooDateTimeToLocal(r.create_date);
      const hour = local.time ? Number(local.time.split(':')[0]) : null;
      return {
        name: r.name,
        state: r.state,
        warehouse: r.warehouse_id?.[1] ?? null,
        create_date_utc: r.create_date,
        create_local_date: local.date,
        create_local_time: local.time,
        after_cutoff: hour !== null ? hour >= cutoffHour : null,
      };
    });

    const withTime = rows.filter(r => r.after_cutoff !== null);
    const afterCutoff = withTime.filter(r => r.after_cutoff);

    return NextResponse.json({
      since,
      cutoffHour,
      total: rows.length,
      total_with_time: withTime.length,
      after_cutoff_count: afterCutoff.length,
      pct_after_cutoff: withTime.length ? Math.round((afterCutoff.length / withTime.length) * 1000) / 10 : null,
      sample: rows.slice(0, 20),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
