import { NextResponse } from 'next/server';
import { odooExecute } from '@/lib/odoo';

export async function GET() {
  try {
    const partners: any[] = await odooExecute('res.partner', 'search_read',
      [[['name', '=', 'MOON FLOWER']]], { fields: ['id', 'name'], limit: 5 });
    const partnerIds = partners.map((p: any) => p.id);
    const orders: any[] = partnerIds.length ? await odooExecute('sale.order', 'search_read',
      [[['partner_id', 'in', partnerIds], ['commitment_date', '>=', '2026-08-03 17:00:00'], ['commitment_date', '<', '2026-08-04 17:00:00']]],
      { fields: ['name', 'state', 'invoice_status', 'commitment_date', 'locked'], limit: 50 }) : [];
    // Also try a broad name-based search in case commitment_date is null/different for this order
    const byPartnerAll: any[] = partnerIds.length ? await odooExecute('sale.order', 'search_read',
      [[['partner_id', 'in', partnerIds]]],
      { fields: ['name', 'state', 'invoice_status', 'commitment_date', 'locked'], limit: 50, order: 'id desc' }) : [];
    return NextResponse.json({ partners, orders, recentAll: byPartnerAll.slice(0, 15) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
