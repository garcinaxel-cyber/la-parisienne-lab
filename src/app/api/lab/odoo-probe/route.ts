import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// READ-ONLY probe: what recipe-relevant data does Odoo hold for a sample product?
// (bill of materials / nomenclature, descriptions) → can recipe cards be auto-filled?
// Every Odoo call is time-boxed so the route can never hang. Admin only, no writes.
function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${label} ${ms}ms`)), ms)),
  ]);
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });

  const sku = new URL(req.url).searchParams.get('sku') || 'BND14C';
  const out: any = { sku };

  // Product core + description (guarded)
  try {
    const rows = await timeout(odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', '=', sku]]],
      { fields: ['default_code', 'name', 'weight', 'list_price', 'categ_id', 'uom_id', 'product_tmpl_id', 'description'], limit: 1 }), 8000, 'product');
    out.product = rows[0] ?? null;
  } catch (e: any) {
    // retry without description if that field is missing
    try {
      const rows = await timeout(odooExecute<any[]>('product.product', 'search_read',
        [[['default_code', '=', sku]]],
        { fields: ['default_code', 'name', 'weight', 'list_price', 'categ_id', 'uom_id', 'product_tmpl_id'], limit: 1 }), 8000, 'product2');
      out.product = rows[0] ?? null;
      out.productNote = 'no description field';
    } catch (e2: any) { out.productError = e2?.message ?? String(e2); }
  }

  // Manufacturing / BoM (the recipe) — time-boxed so it can't hang
  try {
    const tmplId = out.product && Array.isArray(out.product.product_tmpl_id) ? out.product.product_tmpl_id[0] : out.product?.product_tmpl_id;
    const boms = await timeout(odooExecute<any[]>('mrp.bom', 'search_read',
      [tmplId ? [['product_tmpl_id', '=', tmplId]] : []],
      { fields: ['id', 'code', 'product_qty', 'product_uom_id'], limit: 5 }), 8000, 'bom');
    out.bomFound = boms.length;
    out.boms = boms;
    if (boms.length) {
      const lines = await timeout(odooExecute<any[]>('mrp.bom.line', 'search_read',
        [[['bom_id', 'in', boms.map(b => b.id)]]],
        { fields: ['product_id', 'product_qty', 'product_uom_id'], limit: 300 }), 8000, 'bomlines');
      out.bomLines = lines;
    }
  } catch (e: any) {
    out.mrp = `unavailable/timeout: ${e?.message ?? e}`;
  }

  return NextResponse.json(out);
}
