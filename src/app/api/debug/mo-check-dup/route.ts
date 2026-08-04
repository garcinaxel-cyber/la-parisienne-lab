import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// TEMP READ-ONLY diagnostic — no writes, no auth-gated data exposure beyond Odoo MO metadata.
// Checks real Odoo mrp.production quantities for SKUs/dates suspected of a duplicate stock-send
// caused by the manual-cake / Odoo-sync card duplication bug. To be deleted right after use.
const CHECKS: { date: string; skus: string[] }[] = [
  { date: '2026-07-28', skus: ['BSNOGRD14'] },
  { date: '2026-08-04', skus: ['BSNOGRD14', 'BSNCCMCD20', 'BPVL', 'BCYD16', 'BSNCCMCD14'] },
];

export async function GET() {
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });
  const out: any[] = [];
  for (const c of CHECKS) {
    const origin = `Lab ${c.date}`;
    const prods = await odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', 'in', c.skus]]], { fields: ['id', 'name', 'default_code'], limit: 200 });
    const prodIds = prods.map((p: any) => p.id);
    const mos = prodIds.length ? await odooExecute<any[]>('mrp.production', 'search_read',
      [[['origin', '=', origin], ['product_id', 'in', prodIds]]],
      { fields: ['id', 'name', 'product_id', 'product_qty', 'state', 'create_date', 'write_date'], limit: 500 }) : [];
    out.push({ date: c.date, origin, skus: c.skus, products: prods, mos });
  }
  return NextResponse.json({ checks: out });
}
