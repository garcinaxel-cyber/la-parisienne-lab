import { NextResponse } from 'next/server';
import { odooConfigured, odooExecute } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMPORARY debug route — inspect an order's raw Odoo lines (name, notes, display_type).
// Protected by CRON_SECRET. To be removed after exploration.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) return NextResponse.json({ error: 'Odoo not configured' }, { status: 503 });
  const ref = url.searchParams.get('ref') ?? 'S02744';

  try {
    const orders: any[] = await odooExecute('sale.order', 'search_read',
      [[['name', '=', ref]]], { fields: ['id', 'name', 'state', 'note'], limit: 5 });
    if (!orders.length) {
      const repls: any[] = await odooExecute('stock.replenishment.request', 'search_read',
        [[['name', '=', ref]]], { fields: ['id', 'name', 'state'], limit: 5 });
      if (repls.length) {
        const rlines: any[] = await odooExecute('stock.replenishment.request.line', 'search_read',
          [[['request_id', '=', repls[0].id]]],
          { fields: ['product_id', 'quantity_requested', 'name', 'display_type'], limit: 200 });
        return NextResponse.json({ type: 'replenishment', order: repls[0], lines: rlines });
      }
      return NextResponse.json({ error: 'Order not found', ref });
    }
    const order = orders[0];
    const lines: any[] = await odooExecute('sale.order.line', 'search_read',
      [[['order_id', '=', order.id]]],
      { fields: ['product_id', 'product_uom_qty', 'name', 'display_type', 'sequence'], limit: 200 });
    return NextResponse.json({ type: 'sale', order, lines });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 502 });
  }
}
