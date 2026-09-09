import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// Diagnostic READ-ONLY route (2026-09-09) — one-off check of whether given SKUs (default_code)
// exist as Odoo products, before adding them to lab_excluded_skus so they show up in the shop
// "Đặt hàng" packaging search (Axel: add 153-MH.985, VTTH947, VTTH948). Same secret as the
// crons (CRON_SECRET), no writes. Safe to delete once the one-off check is done.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const skusParam = url.searchParams.get('skus');
  if (!skusParam) return NextResponse.json({ error: 'missing ?skus=a,b,c' }, { status: 400 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 503 });
  const skus = skusParam.split(',').map(s => s.trim()).filter(Boolean);

  try {
    const rows = await odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', 'in', skus]]],
      { fields: ['default_code', 'name', 'display_name', 'active', 'type'], context: { lang: 'vi_VN' } });
    const found = rows.map(r => r.default_code);
    const missing = skus.filter(s => !found.includes(s));
    return NextResponse.json({ skus, found: rows, missing });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
