import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// READ-ONLY probe: inspects what recipe-relevant data Odoo actually holds for a sample product
// (bill of materials / nomenclature, descriptions), to decide if recipe cards can be auto-filled
// instead of typed by hand. Admin only, no writes. ?sku=BND14C to pick a product.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });

  const sku = new URL(req.url).searchParams.get('sku') || 'BND14C';
  const out: any = { sku };

  // Product core + description-like fields (guarded — some may not exist per Odoo version)
  const fieldTries = ['default_code', 'name', 'weight', 'list_price', 'categ_id', 'uom_id', 'product_tmpl_id', 'description', 'description_sale', 'description_ecommerce'];
  let prod: any = null;
  for (let i = fieldTries.length; i > 0; i--) {
    try {
      const rows = await odooExecute<any[]>('product.product', 'search_read',
        [[['default_code', '=', sku]]], { fields: fieldTries.slice(0, i), limit: 1 });
      prod = rows[0] ?? null;
      out.productFields = fieldTries.slice(0, i);
      break;
    } catch { /* drop the last field and retry */ }
  }
  out.product = prod;

  // Does this Odoo use Manufacturing (BoM = recipe)? Try, tolerate module-absent errors.
  try {
    out.bomCountTotal = await odooExecute<number>('mrp.bom', 'search_count', [[]]);
    if (prod) {
      const tmplId = Array.isArray(prod.product_tmpl_id) ? prod.product_tmpl_id[0] : prod.product_tmpl_id;
      const boms = await odooExecute<any[]>('mrp.bom', 'search_read',
        [['|', ['product_id', '=', prod.id], ['product_tmpl_id', '=', tmplId]]],
        { fields: ['id', 'code', 'product_qty', 'product_uom_id', 'type'], limit: 5 });
      out.boms = boms;
      if (boms.length) {
        const lines = await odooExecute<any[]>('mrp.bom.line', 'search_read',
          [[['bom_id', 'in', boms.map(b => b.id)]]],
          { fields: ['product_id', 'product_qty', 'product_uom_id'], limit: 300 });
        out.bomLines = lines;
      }
    }
  } catch (e: any) {
    out.mrp = `not available or error: ${e?.message ?? e}`;
  }

  return NextResponse.json(out);
}
