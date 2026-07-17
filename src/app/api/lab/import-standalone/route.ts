import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Import standalone products (no size×flavor structure — e.g. Croissant Meringue flavours) as
// one fiche per product: name = Odoo name, a single "Standard" variant = the SKU, ingredients
// from the BoM. Discover with ?name=Croissant Meringue OR give ?skus=A,B,C. ?team= (default
// baby_mama) ?category= (default 'Cake'). Dry-run by default; ?commit=1 writes. Idempotent by SKU.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const cleanName = (n: string) => n.replace(/^\[[^\]]*\]\s*/, '').trim();

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });

  const url = new URL(req.url);
  const name = url.searchParams.get('name');
  const skusParam = url.searchParams.get('skus');
  const team = url.searchParams.get('team') || 'baby_mama';
  const category = url.searchParams.get('category') || 'Cake';
  const commit = url.searchParams.get('commit') === '1';

  const domain: any[] = skusParam
    ? [['default_code', 'in', skusParam.split(',').map(s => s.trim()).filter(Boolean)]]
    : name ? [['name', 'ilike', name], ['sale_ok', '=', true]] : [];
  if (!domain.length) return NextResponse.json({ error: 'give ?name= or ?skus=' }, { status: 400 });

  const prods = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [domain], { fields: ['id', 'default_code', 'name', 'display_name', 'categ_id', 'weight', 'product_tmpl_id'], limit: 200 }), 15000, 'prods');
  const withSku = prods.filter(p => p.default_code);

  // BoMs (batched)
  const prodIds = withSku.map(p => p.id);
  const boms = prodIds.length ? await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [[['product_id', 'in', prodIds]]], { fields: ['id', 'product_id'], limit: 1000 }), 15000, 'boms') : [];
  const bomByProd: Record<number, number> = {};
  for (const b of boms.sort((a, z) => a.id - z.id)) { const pid = Array.isArray(b.product_id) ? b.product_id[0] : b.product_id; bomByProd[pid] = b.id; }
  const bomIds = Array.from(new Set(Object.values(bomByProd)));
  const lines = bomIds.length ? await tmo(odooExecute<any[]>('mrp.bom.line', 'search_read',
    [[['bom_id', 'in', bomIds]]], { fields: ['bom_id', 'product_id', 'product_qty'], limit: 3000 }), 15000, 'lines') : [];
  const linesByBom: Record<number, any[]> = {};
  for (const l of lines) { const bid = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id; (linesByBom[bid] ??= []).push(l); }

  const plan = withSku.map(p => {
    const bomId = bomByProd[p.id];
    const ings = (bomId ? linesByBom[bomId] ?? [] : []).map(l => ({
      name: cleanName(Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id)),
      g: Math.round((l.product_qty ?? 0) * 10000) / 10,
    }));
    return {
      sku: p.default_code, name: cleanName(p.name), display: p.display_name,
      categ: Array.isArray(p.categ_id) ? p.categ_id[1] : p.categ_id,
      weight: p.weight ?? 0, hasBom: !!bomId, ingredients: ings,
    };
  });

  const summary = { commit, team, category, count: plan.length, products_without_sku: prods.length - withSku.length, without_bom: plan.filter(p => !p.hasBom).length };
  if (!commit) return NextResponse.json({ dryRun: true, summary, plan });

  // WRITE (idempotent by SKU)
  const { data: existing } = await supabase.from('lab_fiche_variants').select('sku').in('sku', plan.map(p => p.sku));
  const existingSkus = new Set((existing ?? []).map((e: any) => e.sku));
  const created: any = { fiches: [], ingredientSteps: 0, skipped_existing: [] };
  for (const p of plan) {
    if (existingSkus.has(p.sku)) { created.skipped_existing.push(p.sku); continue; }
    const { data: fiche, error: fErr } = await supabase.from('lab_fiche_meta').insert({
      name_vi: p.name, name_en: p.name, category, teams: [team], is_active: true,
    }).select('id').single();
    if (fErr || !fiche) return NextResponse.json({ error: 'fiche: ' + fErr?.message, created }, { status: 500 });
    const { data: variant, error: vErr } = await supabase.from('lab_fiche_variants').insert({
      fiche_id: fiche.id, label: 'Standard', sku: p.sku, weight_g: p.weight ? Math.round(p.weight * 1000) : null, is_default: true, sort_order: 0,
    }).select('id').single();
    if (vErr || !variant) return NextResponse.json({ error: 'variant: ' + vErr?.message, created }, { status: 500 });
    if (p.ingredients.length) {
      const stepRows = p.ingredients.map((ing, idx) => ({
        fiche_id: fiche.id, step_type: 'ingredient', step_number: idx + 1,
        description_vi: ing.name, description_en: ing.name, quantity_grams: ing.g, percentage: null,
        duration_minutes: null, temperature_celsius: null,
      }));
      const { data: ins, error: sErr } = await supabase.from('lab_fiche_steps').insert(stepRows).select('id');
      if (sErr) return NextResponse.json({ error: 'steps: ' + sErr.message, created }, { status: 500 });
      const stepIds = (ins ?? []).map((s: any) => s.id);
      const vqRows = p.ingredients.map((ing, idx) => ({ step_id: stepIds[idx], variant_id: variant.id, quantity_grams: ing.g })).filter(r => r.step_id);
      if (vqRows.length) await supabase.from('lab_fiche_variant_quantities').insert(vqRows);
      created.ingredientSteps += stepRows.length;
    }
    created.fiches.push({ name: p.name, sku: p.sku, id: fiche.id });
  }
  return NextResponse.json({ committed: true, summary, created });
}
