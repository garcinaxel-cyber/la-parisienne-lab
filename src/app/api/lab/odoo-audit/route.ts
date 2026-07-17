import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// READ-ONLY audit route (admin only). Reads the Odoo catalogue and compares it to the app's
// recipe-card SKUs to surface gaps that the DB-only audit can't see (products never ordered).
// No writes to Odoo or to the app. Safe to remove once the audit is done.
export async function GET() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });

  // 1. Odoo sellable product variants (default_code = SKU) + their templates
  const products = await odooExecute<any[]>('product.product', 'search_read',
    [[['sale_ok', '=', true]]],
    { fields: ['default_code', 'name', 'categ_id', 'product_tmpl_id'], limit: 10000 });
  const templates = await odooExecute<any[]>('product.template', 'search_read',
    [[['sale_ok', '=', true]]],
    { fields: ['name', 'product_variant_count', 'categ_id'], limit: 10000 });

  // 2. App side: recipe-card SKUs + excluded SKUs
  const [{ data: variants }, { data: excluded }] = await Promise.all([
    supabase.from('lab_fiche_variants').select('sku'),
    supabase.from('lab_excluded_skus').select('sku'),
  ]);
  const appSkus = new Set((variants ?? []).map((v: any) => v.sku).filter(Boolean));
  const excludedSkus = new Set((excluded ?? []).map((e: any) => e.sku).filter(Boolean));

  // 3. Gaps
  const catName = (c: any) => (Array.isArray(c) ? c[1] : c) ?? '';
  const odooWithSku = products.filter(p => p.default_code);
  const odooNoCode = products.filter(p => !p.default_code).length;

  const odooNotInApp = odooWithSku
    .filter(p => !appSkus.has(p.default_code) && !excludedSkus.has(p.default_code))
    .map(p => ({ sku: p.default_code, name: p.name, categ: catName(p.categ_id) }));

  const odooSkuSet = new Set(odooWithSku.map(p => p.default_code));
  const appNotInOdoo = Array.from(appSkus).filter(s => !odooSkuSet.has(s));

  // Template variant-count distribution (1 = "one product per size", >1 = "size variants")
  const dist: Record<string, number> = { '1': 0, '2': 0, '3-6': 0, '7+': 0 };
  for (const t of templates) {
    const n = t.product_variant_count ?? 1;
    if (n <= 1) dist['1']++; else if (n === 2) dist['2']++; else if (n <= 6) dist['3-6']++; else dist['7+']++;
  }

  // Category breakdown of Odoo-not-in-app (to separate cakes from packaging/drinks/fees)
  const byCateg: Record<string, number> = {};
  for (const p of odooNotInApp) byCateg[p.categ] = (byCateg[p.categ] ?? 0) + 1;

  return NextResponse.json({
    summary: {
      odoo_products: products.length,
      odoo_products_without_sku: odooNoCode,
      odoo_templates: templates.length,
      template_variant_distribution: dist,
      app_recipe_card_skus: appSkus.size,
      odoo_skus_not_in_app: odooNotInApp.length,
      app_skus_not_in_odoo: appNotInOdoo.length,
    },
    odoo_not_in_app_by_category: byCateg,
    odoo_not_in_app: odooNotInApp.slice(0, 400),
    app_not_in_odoo: appNotInOdoo.slice(0, 400),
  });
}
