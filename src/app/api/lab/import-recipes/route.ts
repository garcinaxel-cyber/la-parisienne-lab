import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// BULK: for every active fiche that has NO recipe yet, look up the Odoo BoM of each of its variant
// SKUs and fill the ingredients (steps + per-variant grams). Reports what it filled and — crucially
// — a "doubtful" list to review by hand. Reads Odoo (RO), writes only app recipe tables.
// Dry-run by default; ?commit=1 writes. Never touches a fiche that already has recipe steps.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const cleanName = (n: string) => n.replace(/^\[[^\]]*\]\s*/, '').trim();
// Odoo BoM lines carry their OWN unit of measure (g, kg, l, ml, Units…). Convert to grams by that
// unit — assuming everything was kg (and ×1000) turned an 8 g macaron line into 8000 g.
const toGrams = (qty: number, uom: string): number => {
  const u = (uom || '').toLowerCase().trim();
  const q = qty ?? 0;
  if (u === 'kg' || u.includes('kilogram')) return Math.round(q * 1000 * 10) / 10;
  if (u === 'g' || u === 'gr' || u.includes('gram')) return Math.round(q * 10) / 10;
  if (u === 'l' || u.includes('lít') || u.includes('liter') || u.includes('litre')) return Math.round(q * 1000 * 10) / 10;
  if (u === 'ml') return Math.round(q * 10) / 10;
  return Math.round(q * 10) / 10; // Units / unknown → keep raw
};

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });
  const commit = new URL(req.url).searchParams.get('commit') === '1';

  // 1. Active fiches + variants + which already have recipe steps
  const [{ data: fiches }, { data: variants }, { data: steps }] = await Promise.all([
    supabase.from('lab_fiche_meta').select('id, name_vi, name_en').eq('is_active', true),
    supabase.from('lab_fiche_variants').select('id, fiche_id, label, sku'),
    supabase.from('lab_fiche_steps').select('fiche_id').eq('step_type', 'ingredient'),
  ]);
  const hasRecipe = new Set((steps ?? []).map((s: any) => s.fiche_id));
  const varsByFiche: Record<string, any[]> = {};
  for (const v of variants ?? []) (varsByFiche[v.fiche_id] ??= []).push(v);

  const allSkus = Array.from(new Set((variants ?? []).map((v: any) => v.sku).filter(Boolean))) as string[];

  // 2. Odoo: product by SKU → id, then BoMs (latest per product), then lines. Batched.
  const prods = allSkus.length ? await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', allSkus]]], { fields: ['id', 'default_code', 'product_tmpl_id'], limit: 5000 }), 30000, 'prods') : [];
  const prodIdBySku: Record<string, number> = {};
  const tmplByProd: Record<number, number> = {};
  for (const p of prods) if (p.default_code) {
    prodIdBySku[p.default_code] = p.id;
    tmplByProd[p.id] = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
  }
  const prodIds = Object.values(prodIdBySku);
  const tmplIds = Array.from(new Set(Object.values(tmplByProd).filter(Boolean)));

  // BoMs can be attached at the VARIANT level (product_id set) or the TEMPLATE level
  // (product_id false, product_tmpl_id set — the common case for single products). Match both.
  const boms = (prodIds.length || tmplIds.length) ? await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [['|', ['product_id', 'in', prodIds], ['product_tmpl_id', 'in', tmplIds]]],
    { fields: ['id', 'product_id', 'product_tmpl_id'], limit: 20000 }), 30000, 'boms') : [];
  const variantBomByProd: Record<number, number> = {};
  const templateBomByTmpl: Record<number, number> = {};
  const cntByProd: Record<number, number> = {};
  const cntByTmpl: Record<number, number> = {};
  for (const b of boms.sort((a, z) => a.id - z.id)) {
    const pid = Array.isArray(b.product_id) ? b.product_id[0] : (b.product_id || null);
    const tid = Array.isArray(b.product_tmpl_id) ? b.product_tmpl_id[0] : (b.product_tmpl_id || null);
    if (pid) { variantBomByProd[pid] = b.id; cntByProd[pid] = (cntByProd[pid] ?? 0) + 1; }
    else if (tid) { templateBomByTmpl[tid] = b.id; cntByTmpl[tid] = (cntByTmpl[tid] ?? 0) + 1; }
  }
  const bomForSku = (sku: string): number | undefined => {
    const pid = prodIdBySku[sku]; if (!pid) return undefined;
    return variantBomByProd[pid] ?? templateBomByTmpl[tmplByProd[pid]];
  };
  const multiBomSku = (sku: string): boolean => {
    const pid = prodIdBySku[sku]; if (!pid) return false;
    const c = variantBomByProd[pid] ? cntByProd[pid] : cntByTmpl[tmplByProd[pid]];
    return (c ?? 0) > 1;
  };

  const bomIds = Array.from(new Set([...Object.values(variantBomByProd), ...Object.values(templateBomByTmpl)]));
  const lines = bomIds.length ? await tmo(odooExecute<any[]>('mrp.bom.line', 'search_read',
    [[['bom_id', 'in', bomIds]]], { fields: ['bom_id', 'product_id', 'product_qty', 'product_uom_id'], limit: 20000 }), 30000, 'lines') : [];
  const linesByBom: Record<number, any[]> = {};
  for (const l of lines) { const bid = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id; (linesByBom[bid] ??= []).push(l); }

  // 3. Classify each recipe-less fiche
  const willFill: any[] = [];
  const doubtful: any[] = [];
  for (const f of fiches ?? []) {
    if (hasRecipe.has(f.id)) continue; // never overwrite an existing recipe
    const vs = (varsByFiche[f.id] ?? []).filter((v: any) => v.sku);
    const name = f.name_vi || f.name_en || '(no name)';
    if (!vs.length) { doubtful.push({ fiche: name, id: f.id, reason: 'no SKU on any variant' }); continue; }
    const withBom = vs.filter((v: any) => bomForSku(v.sku));
    if (!withBom.length) { doubtful.push({ fiche: name, id: f.id, reason: 'no Odoo BoM for its SKUs', skus: vs.map((v: any) => v.sku) }); continue; }
    const multi = vs.filter((v: any) => multiBomSku(v.sku)).map((v: any) => v.sku);
    const missing = vs.filter((v: any) => !bomForSku(v.sku)).map((v: any) => v.sku);
    // Build the recipe — convert each line BY ITS OWN unit → grams; track per-variant total + odd units
    const ingMap = new Map<string, Record<string, number>>(); const order: string[] = [];
    const totalByVar: Record<string, number> = {};
    const oddUnits = new Set<string>();
    for (const v of withBom) {
      const bomId = bomForSku(v.sku)!;
      for (const l of linesByBom[bomId] ?? []) {
        const nm = cleanName(Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id));
        const uom = Array.isArray(l.product_uom_id) ? l.product_uom_id[1] : '';
        const uL = (uom || '').toLowerCase().trim();
        if (!['g', 'gr', 'kg', 'l', 'ml'].includes(uL) && !uL.includes('gram') && !uL.includes('kilog') && !uL.includes('lít') && !uL.includes('liter')) oddUnits.add(uom || '?');
        const g = toGrams(l.product_qty, uom);
        if (!ingMap.has(nm)) { ingMap.set(nm, {}); order.push(nm); }
        ingMap.get(nm)![v.id] = g; // key by variant id
        totalByVar[v.id] = (totalByVar[v.id] ?? 0) + g;
      }
    }
    const entry: any = { fiche: name, id: f.id, variants_filled: withBom.length, ingredients: order.length, total_g: Math.round(totalByVar[withBom[0].id] ?? 0) };
    if (multi.length) entry.note = `multiple BoMs on: ${multi.join(',')} (took latest)`;
    if (missing.length) entry.partial = `no BoM for: ${missing.join(',')}`;
    if (oddUnits.size) entry.check_units = Array.from(oddUnits).join(',');
    willFill.push(entry);
    if (commit) {
      const defVarId = withBom[0].id;
      const stepRows = order.map((nm, idx) => ({
        fiche_id: f.id, step_type: 'ingredient', step_number: idx + 1,
        description_vi: nm, description_en: nm, quantity_grams: ingMap.get(nm)![defVarId] ?? null,
        percentage: null, duration_minutes: null, temperature_celsius: null,
      }));
      const { data: ins, error: sErr } = await supabase.from('lab_fiche_steps').insert(stepRows).select('id');
      if (sErr) { entry.error = sErr.message; continue; }
      const stepIds = (ins ?? []).map((s: any) => s.id);
      const vqRows: any[] = [];
      order.forEach((nm, idx) => { const sid = stepIds[idx]; if (!sid) return; for (const [vid, g] of Object.entries(ingMap.get(nm)!)) vqRows.push({ step_id: sid, variant_id: vid, quantity_grams: g }); });
      if (vqRows.length) await supabase.from('lab_fiche_variant_quantities').insert(vqRows);
      // Fill each variant's total finished weight (sum of its ingredients) on the recipe card
      for (const v of withBom) {
        const tot = Math.round((totalByVar[v.id] ?? 0) * 10) / 10;
        if (tot > 0) await supabase.from('lab_fiche_variants').update({ weight_g: tot }).eq('id', v.id);
      }
    }
  }

  return NextResponse.json({
    committed: commit,
    summary: { fiches_active: (fiches ?? []).length, already_had_recipe: hasRecipe.size, will_fill: willFill.length, doubtful: doubtful.length },
    willFill, doubtful,
  });
}
