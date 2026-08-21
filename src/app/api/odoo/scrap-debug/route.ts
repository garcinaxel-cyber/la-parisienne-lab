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
  // Run independently — the write account may lack Inventory group access to one model
  // (e.g. stock.scrap.reason.tag needs Inventory/User) without that blocking the other.
  const out: { fields?: any; fieldsError?: string; reasonTags?: any; reasonTagsError?: string } = {};
  try {
    out.fields = await inspectScrapFields();
  } catch (e: any) {
    out.fieldsError = String(e?.message ?? e);
  }
  try {
    out.reasonTags = await getScrapReasonTags();
  } catch (e: any) {
    out.reasonTagsError = String(e?.message ?? e);
  }
  return NextResponse.json(out);
}
