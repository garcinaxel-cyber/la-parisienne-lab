import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Generic version of the Nappa pilot: build recipe cards for a whole flavored family from Odoo.
// One fiche per (family, flavor) — family + flavor read from the Odoo variant display_name so it
// works across families (incl. La Perla vs La Plume that share the BLPD prefix). Variants = sizes,
// ingredients per size from each SKU's BoM (grams). Reads Odoo (RO), writes only app fiche tables.
// ?prefix=BMDD (SKU prefix, required) · ?team=baby_mama (default) · ?commit=1 to write. Admin only.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const cleanName = (n: string) => n.replace(/^\[[^\]]*\]\s*/, '').trim();
const SIZE_ORDER = ['D8', 'D10', 'D12', 'D14', 'D16', 'D18', 'D20', 'D22', 'D24', 'D26'];

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });

  const url = new URL(req.url);
  const prefix = url.searchParams.get('prefix');
  const team = url.searchParams.get('team') || 'baby_mama';
  const commit = url.searchParams.get('commit') === '1';
  if (!prefix) return NextResponse.json({ error: 'prefix required (e.g. ?prefix=BMDD)' }, { status: 400 });

  // 1. Products
  const prods = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', '=like', `${prefix}%`]]],
    { fields: ['id', 'default_code', 'name', 'display_name', 'product_tmpl_id', 'weight'], limit: 500 }), 15000, 'prods');

  // Parse family + flavor + size from Odoo names
  type Parsed = { p: any; family: string; flavor: string; size: string };
  const parsed: Parsed[] = [];
  const unparsed: any[] = [];
  for (const p of prods) {
    const sizeM = /\bD(\d+)\b/.exec(p.name || '');
    const flavM = /\(([^)]+)\)\s*$/.exec(p.display_name || '');
    if (!sizeM || !flavM) { unparsed.push({ sku: p.default_code, name: p.name, display_name: p.display_name }); continue; }
    const size = 'D' + sizeM[1];
    const flavor = flavM[1].trim();
    const family = (p.name || '').replace(/\s*\bD\d+\b\s*/, ' ').trim(); // family = name minus size
    parsed.push({ p, family, flavor, size });
  }

  // 2. BoMs (batched)
  const prodIds = parsed.map(x => x.p.id);
  const boms = prodIds.length ? await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [[['product_id', 'in', prodIds]]], { fields: ['id', 'product_id'], limit: 2000 }), 15000, 'boms') : [];
  const bomByProd: Record<number, number> = {};
  for (const b of boms.sort((a, z) => a.id - z.id)) {
    const pid = Array.isArray(b.product_id) ? b.product_id[0] : b.product_id;
    bomByProd[pid] = b.id;
  }
  const bomIds = Array.from(new Set(Object.values(bomByProd)));
  const lines = bomIds.length ? await tmo(odooExecute<any[]>('mrp.bom.line', 'search_read',
    [[['bom_id', 'in', bomIds]]], { fields: ['bom_id', 'product_id', 'product_qty'], limit: 5000 }), 15000, 'lines') : [];
  const linesByBom: Record<number, any[]> = {};
  for (const l of lines) {
    const bid = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id;
    (linesByBom[bid] ??= []).push(l);
  }

  // 3. Plan: one fiche per (family, flavor)
  type V = { size: string; sku: string; weight: number; ingredients: { name: string; kg: number }[] };
  const plan: Record<string, { name: string; family: string; flavor: string; variants: V[] }> = {};
  for (const x of parsed) {
    const key = `${x.family}||${x.flavor}`;
    (plan[key] ??= { name: `${x.family} ${x.flavor}`, family: x.family, flavor: x.flavor, variants: [] });
    const bomId = bomByProd[x.p.id];
    const ings = (bomId ? linesByBom[bomId] ?? [] : []).map(l => ({
      name: cleanName(Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id)),
      kg: l.product_qty,
    }));
    plan[key].variants.push({ size: x.size, sku: x.p.default_code, weight: x.p.weight ?? 0, ingredients: ings });
  }
  for (const k of Object.keys(plan)) plan[k].variants.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));

  const summary = {
    commit, prefix, team, fiches: Object.keys(plan).length,
    variants: parsed.length, unparsed: unparsed.length,
    variants_without_bom: parsed.filter(x => !bomByProd[x.p.id]).length,
  };
  if (!commit) return NextResponse.json({ dryRun: true, summary, fiches: Object.keys(plan), unparsed, plan });

  // 4. WRITE (idempotent by SKU)
  const allSkus = parsed.map(x => x.p.default_code);
  const { data: existing } = await supabase.from('lab_fiche_variants').select('sku').in('sku', allSkus);
  const existingSkus = new Set((existing ?? []).map((e: any) => e.sku));
  const toG = (kg: number) => Math.round((kg ?? 0) * 10000) / 10;

  const created: any = { fiches: [], variants: 0, ingredientSteps: 0, variantQuantities: 0, skipped_existing: 0 };
  for (const key of Object.keys(plan)) {
    const f = plan[key];
    const toAdd = f.variants.filter(v => !existingSkus.has(v.sku));
    if (!toAdd.length) { created.skipped_existing += f.variants.length; continue; }

    const { data: fiche, error: fErr } = await supabase.from('lab_fiche_meta').insert({
      name_vi: f.name, name_en: f.name, category: 'Birthday cake', teams: [team], is_active: true,
    }).select('id').single();
    if (fErr || !fiche) return NextResponse.json({ error: 'fiche: ' + fErr?.message, created }, { status: 500 });
    const ficheId = fiche.id;
    created.fiches.push({ name: f.name, id: ficheId, variants: toAdd.length });

    const variantIdBySize: Record<string, string> = {};
    for (let i = 0; i < toAdd.length; i++) {
      const v = toAdd[i];
      const { data: variant, error: vErr } = await supabase.from('lab_fiche_variants').insert({
        fiche_id: ficheId, label: v.size, sku: v.sku, weight_g: v.weight ? Math.round(v.weight * 1000) : null,
        is_default: i === 0, sort_order: i,
      }).select('id').single();
      if (vErr || !variant) return NextResponse.json({ error: 'variant: ' + vErr?.message, created }, { status: 500 });
      variantIdBySize[v.size] = variant.id;
      created.variants++;
    }

    const ingMap = new Map<string, Record<string, number>>();
    const order: string[] = [];
    for (const v of toAdd) for (const ing of v.ingredients) {
      if (!ingMap.has(ing.name)) { ingMap.set(ing.name, {}); order.push(ing.name); }
      ingMap.get(ing.name)![v.size] = toG(ing.kg);
    }
    const defSize = toAdd[0].size;
    const stepRows = order.map((name, idx) => ({
      fiche_id: ficheId, step_type: 'ingredient', step_number: idx + 1,
      description_vi: name, description_en: name,
      quantity_grams: ingMap.get(name)![defSize] ?? null, percentage: null,
      duration_minutes: null, temperature_celsius: null,
    }));
    let stepIds: string[] = [];
    if (stepRows.length) {
      const { data: ins, error: sErr } = await supabase.from('lab_fiche_steps').insert(stepRows).select('id');
      if (sErr) return NextResponse.json({ error: 'steps: ' + sErr.message, created }, { status: 500 });
      stepIds = (ins ?? []).map((s: any) => s.id);
      created.ingredientSteps += stepRows.length;
    }
    const vqRows: any[] = [];
    order.forEach((name, idx) => {
      const stepId = stepIds[idx]; if (!stepId) return;
      for (const [size, grams] of Object.entries(ingMap.get(name)!)) {
        const vId = variantIdBySize[size];
        if (vId) vqRows.push({ step_id: stepId, variant_id: vId, quantity_grams: grams });
      }
    });
    if (vqRows.length) {
      const { error: vqErr } = await supabase.from('lab_fiche_variant_quantities').insert(vqRows);
      if (vqErr) return NextResponse.json({ error: 'vq: ' + vqErr.message, created }, { status: 500 });
      created.variantQuantities += vqRows.length;
    }
  }
  return NextResponse.json({ committed: true, summary, created });
}
