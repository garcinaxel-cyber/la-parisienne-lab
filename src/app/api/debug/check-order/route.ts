import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// TEMP READ-ONLY diagnostic — checks whether a given sale.order still exists in Odoo and what
// lines it currently has. No writes. To be deleted right after use.
export async function GET(req: Request) {
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });
  const url = new URL(req.url);
  const ref = url.searchParams.get('ref') ?? 'S03035';
  const orders = await odooExecute<any[]>('sale.order', 'search_read',
    [[['name', '=', ref]]], { fields: ['id', 'name', 'state', 'partner_id', 'commitment_date', 'write_date'], limit: 5 });
  let lines: any[] = [];
  if (orders.length) {
    const orderIds = orders.map((o: any) => o.id);
    lines = await odooExecute<any[]>('sale.order.line', 'search_read',
      [[['order_id', 'in', orderIds], ['display_type', '=', false]]],
      { fields: ['order_id', 'product_id', 'product_uom_qty', 'name'], limit: 200 });
  }
  return NextResponse.json({ ref, orders, lines });
}
