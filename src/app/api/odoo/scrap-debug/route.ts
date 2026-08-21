import { NextResponse } from 'next/server';
import { odooConfigured } from '@/lib/odoo';
import { inspectScrapFields, getScrapReasonTags } from '@/lib/odoo-scrap';

export const dynamic = 'force-dynamic';

// Read-only diagnostic (2026-08-21) — verifying stock.scrap's real field names/requirements on
// this Odoo instance before wiring the shop loss-recording feature's write path. Same pattern as
// /api/odoo/confirm-mos?inspect=. No writes ever happen here.
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
    const [fields, reasonTags] = await Promise.all([inspectScrapFields(), getScrapReasonTags()]);
    return NextResponse.json({ fields, reasonTags });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'inspect failed' }, { status: 502 });
  }
}
