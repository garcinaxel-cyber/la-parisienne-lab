import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured, labTodayUtcThreshold } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// TEMP admin read-only: why is an Odoo order ref absent from the app? Checks the exact sync
// criteria (state + commitment_date) and whether it's already in the app DB. ?ref=S02907
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });
  const ref = new URL(req.url).searchParams.get('ref') || 'S02907';
  const threshold = labTodayUtcThreshold();

  // Odoo: the sale order by name (any state), + its lines + product SKUs
  const so = await tmo(odooExecute<any[]>('sale.order', 'search_read',
    [[['name', '=', ref]]], { fields: ['name', 'state', 'commitment_date', 'partner_id', 'date_order'], limit: 5 }), 20000, 'so');
  const rr = so.length ? [] : await tmo(odooExecute<any[]>('stock.replenishment.request', 'search_read',
    [[['name', '=', ref]]], { fields: ['name', 'state', 'delivery_date', 'warehouse_id'], limit: 5 }), 20000, 'rr');

  let lines: any[] = [];
  let products: any[] = [];
  if (so.length) {
    const soLines = await tmo(odooExecute<any[]>('sale.order.line', 'search_read',
      [[['order_id', '=', so[0].id], ['display_type', '=', false]]],
      { fields: ['product_id', 'product_uom_qty', 'name'], limit: 200 }), 20000, 'lines');
    lines = soLines;
    const pids = Array.from(new Set(soLines.map((l: any) => l.product_id?.[0]).filter(Boolean)));
    products = pids.length ? await tmo(odooExecute<any[]>('product.product', 'read', [pids], { fields: ['default_code', 'name'] }), 15000, 'prod') : [];
  }
  const skuById: Record<number, any> = {};
  for (const p of products) skuById[p.id] = { sku: p.default_code || null, name: p.name };

  // App DB: is it already imported? any pending change?
  const { data: appLines } = await supabase.from('lab_order_lines')
    .select('id, delivery_date, import_id, product_sku, qty, published').eq('order_ref', ref);
  const { data: changes } = await supabase.from('lab_odoo_changes').select('order_ref, status, cancelled').eq('order_ref', ref);

  const o = so[0] ?? null;
  const passesState = o ? ['draft', 'sent', 'sale'].includes(o.state) : (rr[0] ? ['draft', 'submitted', 'approved'].includes(rr[0].state) : false);
  const dateVal = o?.commitment_date ?? rr[0]?.delivery_date ?? null;
  const passesDate = !!dateVal && String(dateVal) >= threshold;

  return NextResponse.json({
    ref, threshold_utc: threshold,
    odoo_sale_order: o, odoo_replenishment: rr[0] ?? null,
    lines: lines.map((l: any) => ({
      product: l.product_id?.[1], sku: skuById[l.product_id?.[0]]?.sku ?? null,
      qty: l.product_uom_qty,
    })),
    diagnosis: {
      exists_in_odoo: !!(o || rr[0]),
      state: o?.state ?? rr[0]?.state ?? null,
      delivery_date: dateVal,
      passes_state_filter: passesState,
      passes_date_filter: passesDate,
      would_be_synced: passesState && passesDate,
      all_lines_missing_sku: lines.length > 0 && lines.every((l: any) => !skuById[l.product_id?.[0]]?.sku),
      already_in_app: (appLines ?? []).length,
      pending_change: changes ?? [],
    },
  });
}
