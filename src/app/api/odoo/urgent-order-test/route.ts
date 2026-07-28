import { NextResponse } from 'next/server';
import { odooExecute, odooWriteConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// TEMPORARY — read-only lookup to understand why 2 quotations exist for Moon Flower today.
// No writes. To be deleted right after diagnosis.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooWriteConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 503 });

  try {
    const partners = await odooExecute<any[]>('res.partner', 'search_read', [[['name', 'ilike', 'MOON FLOWER']]], { fields: ['id', 'name'], limit: 20 });
    const orders = await odooExecute<any[]>('sale.order', 'search_read',
      [[['partner_id', 'in', partners.map((p: any) => p.id)]]],
      { fields: ['id', 'name', 'state', 'create_date', 'write_date', 'commitment_date', 'amount_total'], limit: 50, order: 'create_date desc' });
    const orderIds = orders.map((o: any) => o.id);
    const lines = orderIds.length ? await odooExecute<any[]>('sale.order.line', 'search_read',
      [[['order_id', 'in', orderIds]]], { fields: ['order_id', 'product_id', 'product_uom_qty', 'name'], limit: 200 }) : [];
    return NextResponse.json({ partners, orders, lines });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
