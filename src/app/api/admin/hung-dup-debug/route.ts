import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMPORARY — Axel, 2026-09-08: checking a duplicate reception note (Phiếu #8EE131 /
// #D6B25B, team "hung", 10 SKUs, lab-day 2026-09-07) for real impact on Odoo MOs. Read-only.
const DEBUG_KEY = '4ik7FDJYSbKV1nVwwv1sXpvLe2afgxgE';
const SKUS = ['BBCFC','WBCFC','WBGF','WBMF','WBMF1','WBPCF','WBSF','WBSF1','WMMCH'];

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== DEBUG_KEY) return NextResponse.json({ error: 'nope' }, { status: 401 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 503 });

  const products = await odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', SKUS]]], { fields: ['id', 'default_code', 'name'], limit: 50 });
  const idBySku: Record<string, number> = {};
  for (const p of products) idBySku[p.default_code] = p.id;
  const ids = Object.values(idBySku);

  const mos = ids.length ? await odooExecute<any[]>('mrp.production', 'search_read',
    [[['product_id', 'in', ids], ['origin', 'in', ['Lab 2026-09-07', 'Lab 2026-09-08']]]],
    { fields: ['name', 'product_id', 'state', 'product_qty', 'qty_producing', 'origin', 'date_start', 'date_finished'], limit: 100 }) : [];

  return NextResponse.json({ idBySku, mos });
}
