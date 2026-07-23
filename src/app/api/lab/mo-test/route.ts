import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// TEMP test — create ONE draft Manufacturing Order (mrp.production) in Odoo, to validate that
// the API account can write. Dry-run by default (shows what it would create, reads only).
// ?commit=1 creates exactly one draft MO and returns its Odoo reference (to delete by hand).
// ?sku= to force a product, ?qty= (default 1). Admin only. Delete this route after the test.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured (ODOO_* env not available in this environment)' }, { status: 500 });

  const url = new URL(req.url);
  const commit = url.searchParams.get('commit') === '1';
  const qty = Number(url.searchParams.get('qty') || '1') || 1;
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
  let sku = url.searchParams.get('sku');

  // If no SKU given, pick the first "done" card of the day that has a SKU (single line test)
  let pickedFrom: any = null;
  if (!sku) {
    const { data: asg } = await supabase.from('lab_assignments')
      .select('variant_id, product_name_vi, qty_produced, total_qty, lab_imports!inner(delivery_date,status)')
      .eq('lab_imports.status', 'published').eq('lab_imports.delivery_date', date)
      .eq('status', 'done').not('variant_id', 'is', null).limit(50);
    const vids = Array.from(new Set((asg ?? []).map((a: any) => a.variant_id).filter(Boolean)));
    const { data: vars } = vids.length
      ? await supabase.from('lab_fiche_variants').select('id, sku').in('id', vids)
      : { data: [] as any[] };
    const skuByV: Record<string, string> = {};
    for (const v of vars ?? []) if (v.sku) skuByV[v.id] = v.sku;
    const first = (asg ?? []).find((a: any) => skuByV[a.variant_id]);
    if (first) { sku = skuByV[first.variant_id]; pickedFrom = { product_name_vi: first.product_name_vi, qty_produced: first.qty_produced }; }
  }
  if (!sku) return NextResponse.json({ error: 'no SKU to test (give ?sku=, or run on a day with done cards)' }, { status: 400 });

  // Resolve product + uom + a BoM (all read-only)
  const prods = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', '=', sku]]], { fields: ['id', 'name', 'uom_id', 'product_tmpl_id'], limit: 1 }), 20000, 'prod');
  const p = prods[0];
  if (!p) return NextResponse.json({ error: `SKU ${sku} not found in Odoo` }, { status: 404 });
  const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
  const boms = await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [['|', ['product_id', '=', p.id], ['product_tmpl_id', '=', tmplId]]], { fields: ['id'], limit: 1 }), 20000, 'bom');

  const vals: Record<string, any> = {
    product_id: p.id,
    product_qty: qty,
    product_uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id,
  };
  if (boms[0]) vals.bom_id = boms[0].id;

  const plan = { sku, product: p.name, product_id: p.id, qty, bom_id: boms[0]?.id ?? null, pickedFrom, values: vals };

  if (!commit) return NextResponse.json({ dryRun: true, willCreate: plan });

  // WRITE: create exactly one draft MO
  try {
    const id = await tmo(odooExecute<number>('mrp.production', 'create', [vals]), 25000, 'create');
    const [mo] = await tmo(odooExecute<any[]>('mrp.production', 'read',
      [[id]], { fields: ['name', 'state', 'product_qty', 'product_id'] }), 15000, 'read');
    return NextResponse.json({ committed: true, created: { id, name: mo?.name, state: mo?.state, qty: mo?.product_qty }, plan });
  } catch (e: any) {
    return NextResponse.json({ committed: false, error: String(e?.message ?? e), plan }, { status: 502 });
  }
}
