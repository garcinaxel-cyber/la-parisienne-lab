import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Fill in the name of fiches that have an empty name_vi (they show up as "· D14" / bare SKU),
// and repair manual cakes whose product_name_vi is just the SKU — both from the real Odoo product
// name. Fiche name = Odoo name minus the size suffix. Reads Odoo (RO), writes only app tables.
// Dry-run by default; ?commit=1 to write. Admin only.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const stripSize = (n: string) => n.replace(/\s*\bD\d+\b\s*$/i, '').replace(/\s+/g, ' ').trim();

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });
  const commit = new URL(req.url).searchParams.get('commit') === '1';

  // 1. Empty-name fiches + one SKU each
  const { data: emptyFiches } = await supabase.from('lab_fiche_meta')
    .select('id, name_vi, lab_fiche_variants(sku, label)').or('name_vi.is.null,name_vi.eq.');
  // 2. Manual cakes whose name == sku
  const { data: manualCakes } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, product_name_vi');
  const brokenManual = (manualCakes ?? []).filter((m: any) => m.product_sku && m.product_name_vi === m.product_sku);

  // Collect SKUs to resolve
  const skuSet = new Set<string>();
  const ficheSku: Record<string, string> = {};
  for (const f of emptyFiches ?? []) {
    const v = (f.lab_fiche_variants ?? []).find((x: any) => x.sku);
    if (v?.sku) { ficheSku[f.id] = v.sku; skuSet.add(v.sku); }
  }
  for (const m of brokenManual) skuSet.add(m.product_sku);
  const skus = Array.from(skuSet);

  const nameBySku: Record<string, string> = {};
  if (skus.length) {
    const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', 'in', skus]]], { fields: ['default_code', 'name'], limit: 2000 }), 15000, 'odoo');
    for (const r of rows) if (r.default_code) nameBySku[r.default_code] = (r.name || '').trim();
  }

  const fichePlan = (emptyFiches ?? []).map((f: any) => {
    const sku = ficheSku[f.id];
    const odooName = sku ? nameBySku[sku] : null;
    return { id: f.id, sku: sku ?? null, odooName: odooName ?? null, newName: odooName ? stripSize(odooName) : null };
  }).filter(p => p.newName);
  const manualPlan = brokenManual.map((m: any) => ({
    id: m.id, sku: m.product_sku, newName: nameBySku[m.product_sku] ?? null,
  })).filter(p => p.newName);

  if (!commit) {
    return NextResponse.json({
      dryRun: true,
      empty_fiches_total: (emptyFiches ?? []).length, fiches_to_name: fichePlan.length,
      broken_manual_total: brokenManual.length, manual_to_fix: manualPlan.length,
      fichePlan, manualPlan,
    });
  }

  let fichesNamed = 0, manualFixed = 0;
  for (const p of fichePlan) {
    const { error } = await supabase.from('lab_fiche_meta').update({ name_vi: p.newName, name_en: p.newName }).eq('id', p.id);
    if (!error) fichesNamed++;
  }
  for (const p of manualPlan) {
    const { error } = await supabase.from('lab_manual_cakes').update({ product_name_vi: p.newName }).eq('id', p.id);
    if (!error) manualFixed++;
  }
  return NextResponse.json({ committed: true, fichesNamed, manualFixed });
}
