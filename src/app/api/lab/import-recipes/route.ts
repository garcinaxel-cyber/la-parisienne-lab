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
const toG = (kg: number) => Math.round((kg ?? 0) * 10000) / 10;

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
    [[['default_code', 'in', allSkus]]], { fields: ['id', 'default_code'], limit: 5000 }), 30000, 'prods') : [];
  const prodIdBySku: Record<string, number> = {};
  const skuByProdId: Record<number, string> = {};
  for (const p of prods) if (p.default_code) { prodIdBySku[p.default_code] = p.id; skuByProdId[p.id] = p.default_code; }
  const prodIds = Object.values(prodIdBySku);

  const boms = prodIds.length ? await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [[['product_id', 'in', prodIds]]], { fields: ['id', 'product_id'], limit: 10000 }), 30000, 'boms') : [];
  const bomIdByProd: Record<number, number> = {};
  const bomCountByProd: Record<number, number> = {};
  for (const b of boms.sort((a, z) => a.id - z.id)) {
    const pid = Array.isArray(b.product_id) ? b.product_id[0] : b.product_id;
    bomIdByProd[pid] = b.id; bomCountByProd[pid] = (bomCountByProd[pid] ?? 0) + 1;
  }
  const bomIds = Array.from(new Set(Object.values(bomIdByProd)));
  const lines = bomIds.length ? await tmo(odooExecute<any[]>('mrp.bom.line', 'search_read',
    [[['bom_id', 'in', bomIds]]], { fields: ['bom_id', 'product_id', 'product_qty'], limit: 20000 }), 30000, 'lines') : [];
  const linesByBom: Record<number, any[]> = {};
  for (const l of lines) { const bid = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id; (linesByBom[bid] ??= []).push(l); }

  const bomForSku = (sku: string) => { const pid = prodIdBySku[sku]; return pid ? bomIdByProd[pid] : undefined; };
  const multiBomSku = (sku: string) => { const pid = prodIdBySku[sku]; return pid ? (bomCountByProd[pid] ?? 0) > 1 : false; };

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
    // Build the recipe
    const ingMap = new Map<string, Record<string, number>>(); const order: string[] = [];
    for (const v of withBom) {
      const bomId = bomForSku(v.sku)!;
      for (const l of linesByBom[bomId] ?? []) {
        const nm = cleanName(Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id));
        if (!ingMap.has(nm)) { ingMap.set(nm, {}); order.push(nm); }
        ingMap.get(nm)![v.id] = toG(l.product_qty); // key by variant id
      }
    }
    const entry: any = { fiche: name, id: f.id, variants_filled: withBom.length, ingredients: order.length };
    if (multi.length) entry.note = `multiple BoMs on: ${multi.join(',')} (took latest)`;
    if (missing.length) entry.partial = `no BoM for: ${missing.join(',')}`;
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
    }
  }

  return NextResponse.json({
    committed: commit,
    summary: { fiches_active: (fiches ?? []).length, already_had_recipe: hasRecipe.size, will_fill: willFill.length, doubtful: doubtful.length },
    willFill, doubtful,
  });
}
