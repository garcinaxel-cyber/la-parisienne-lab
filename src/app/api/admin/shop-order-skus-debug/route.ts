import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';
import { SHOP_CONFIG } from '@/lib/shops';

export const dynamic = 'force-dynamic';

// Diagnostic READ-ONLY route (2026-09-03) — one-off data pull for the shop-ordering feature
// planning (Axel: "analyse les commandes des shops sur 90j pour voir s'il manque pas des
// packagings qu'on devrait ajouter à la liste"). Dumps every product ordered on a
// stock.replenishment.request delivered to one of the 4 La Paris shop warehouses over the
// requested window, aggregated by SKU (qty + request count) — the classification against
// lab_fiche_variants / lab_excluded_skus is done afterward from Supabase, not here, so this
// route stays a dumb data dump like odoo-ref-debug rather than embedding business logic that
// would need maintaining. Same secret as the crons (CRON_SECRET), no writes.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 503 });

  const days = Number(url.searchParams.get('days') ?? '90');
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  try {
    const warehouseCodes = Object.values(SHOP_CONFIG)
      .filter(c => c.docType === 'replenishment' && c.warehouseCode)
      .map(c => c.warehouseCode as string);

    const warehouses = await odooExecute<any[]>('stock.warehouse', 'search_read',
      [[['code', 'in', warehouseCodes]]], { fields: ['id', 'code', 'name'] });
    const whIds = warehouses.map(w => w.id);
    if (!whIds.length) return NextResponse.json({ error: 'no shop warehouses found on Odoo', warehouseCodes });

    const requests = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
      [[['warehouse_id', 'in', whIds], ['delivery_date', '>=', sinceIso]]],
      { fields: ['id', 'name', 'warehouse_id', 'delivery_date'], limit: 2000 });
    const reqIds = requests.map(r => r.id);
    if (!reqIds.length) return NextResponse.json({ ok: true, requestsChecked: 0, windowDays: days, skus: [] });

    const lines = await odooExecute<any[]>('stock.replenishment.request.line', 'search_read',
      [[['request_id', 'in', reqIds]]], { fields: ['request_id', 'product_id', 'quantity_requested'], limit: 20000 });

    const productIds = Array.from(new Set(lines.map(l => l.product_id?.[0]).filter(Boolean)));
    const products = productIds.length
      ? await odooExecute<any[]>('product.product', 'read', [productIds],
          { fields: ['default_code', 'name', 'display_name'], context: { lang: 'vi_VN' } })
      : [];
    const bySku: Record<number, { sku: string; name: string }> = {};
    for (const p of products) {
      const variantName = String(p.display_name || '').replace(/\[.*?\]\s*/, '').trim();
      bySku[p.id] = { sku: p.default_code || '', name: variantName || p.name || '' };
    }

    const agg = new Map<string, { sku: string; name: string; totalQty: number; requestRefs: Set<string> }>();
    const reqById: Record<number, string> = {};
    for (const r of requests) reqById[r.id] = r.name;
    for (const l of lines) {
      const info = bySku[l.product_id?.[0]];
      if (!info?.sku) continue;
      const cur = agg.get(info.sku) ?? { sku: info.sku, name: info.name, totalQty: 0, requestRefs: new Set<string>() };
      cur.totalQty += Number(l.quantity_requested ?? 0);
      const ref = reqById[l.request_id?.[0]];
      if (ref) cur.requestRefs.add(ref);
      agg.set(info.sku, cur);
    }

    const skus = Array.from(agg.values())
      .map(v => ({ sku: v.sku, name: v.name, totalQty: v.totalQty, requestCount: v.requestRefs.size }))
      .sort((a, b) => b.requestCount - a.requestCount);

    return NextResponse.json({ ok: true, requestsChecked: requests.length, windowDays: days, skus });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
