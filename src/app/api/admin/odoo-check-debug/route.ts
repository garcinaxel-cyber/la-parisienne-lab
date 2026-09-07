import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMPORARY diagnostic route — Axel, 2026-09-07, stock reconciliation session. Read-only Odoo
// account, no writes. Remove after use (see chat: "connecte-toi a odoo stp").
const DEBUG_KEY = '4ik7FDJYSbKV1nVwwv1sXpvLe2afgxgE';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== DEBUG_KEY) return NextResponse.json({ error: 'nope' }, { status: 401 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 503 });

  try {
    const bmcrhhProduct = await odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', '=', 'BMCRHH']]], { fields: ['id', 'name'], limit: 5 });
    const bmcrhhId = bmcrhhProduct[0]?.id;
    const mos = bmcrhhId ? await odooExecute<any[]>('mrp.production', 'search_read',
      [[['product_id', '=', bmcrhhId], ['create_date', '>=', '2026-09-05 00:00:00']]],
      { fields: ['name', 'state', 'product_qty', 'qty_producing', 'date_start', 'date_finished', 'create_date', 'origin'], limit: 50 }) : [];

    const quants = bmcrhhId ? await odooExecute<any[]>('stock.quant', 'search_read',
      [[['product_id', '=', bmcrhhId]]], { fields: ['location_id', 'quantity', 'inventory_quantity'], limit: 20 }) : [];

    const moves = bmcrhhId ? await odooExecute<any[]>('stock.move', 'search_read',
      [[['product_id', '=', bmcrhhId], ['date', '>=', '2026-09-05 00:00:00']]],
      { fields: ['reference', 'state', 'product_qty', 'location_id', 'location_dest_id', 'date', 'origin'], limit: 50 }) : [];

    const pickings = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['name', 'ilike', '01354']]],
      { fields: ['name', 'state', 'scheduled_date', 'date_done', 'origin', 'partner_id', 'location_id', 'location_dest_id'], limit: 10 });
    const pickingsByOrigin = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['origin', 'ilike', '01354']]],
      { fields: ['name', 'state', 'scheduled_date', 'date_done', 'origin', 'partner_id', 'location_id', 'location_dest_id'], limit: 10 });
    const pickingId = pickings[0]?.id ?? pickingsByOrigin[0]?.id;
    const pickingMoves = pickingId ? await odooExecute<any[]>('stock.move', 'search_read',
      [[['picking_id', '=', pickingId]]], { fields: ['product_id', 'product_qty', 'quantity', 'state'], limit: 50 }) : [];
    const saleOrders = await odooExecute<any[]>('sale.order', 'search_read',
      [[['name', 'ilike', '01354']]], { fields: ['name', 'state', 'partner_id', 'date_order'], limit: 10 }).catch(() => []);

    return NextResponse.json({ bmcrhhId, mos, quants, moves, pickings, pickingsByOrigin, pickingMoves, saleOrders });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
