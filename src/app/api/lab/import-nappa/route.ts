import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// PILOT: build recipe cards for the "Nappa" family from Odoo (products + Bill of Materials).
// One fiche per FLAVOR, variants = sizes, ingredients per variant (from that SKU's BoM).
// Reads Odoo (read-only) and writes ONLY to the app's fiche tables. Idempotent (skips SKUs that
// already exist). Dry-run by default; add ?commit=1 to actually write. Admin only.
const FLAVOR: Record<string, string> = {
  CSC: 'Coffee & salted caramel', EGP: 'Earl grey & peach',
  MC: 'Matcha & coconut', VM: 'Vanilla & mango', C: 'Chocolate',
};
const SUFFIX_ORDER = ['CSC', 'EGP', 'VM', 'MC', 'C']; // longest / disambiguating first

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
function parseSku(sku: string) {
  for (const suf of SUFFIX_ORDER) {
    if (sku.startsWith('BND') && sku.endsWith(suf)) {
      const mid = sku.slice(3, sku.length - suf.length);
      if (/^\d+$/.test(mid)) return { size: 'D' + mid, flavor: FLAVOR[suf], suf };
    }
  }
  return null;
}
const cleanName = (n: string) => n.replace(/^\[[^\]]*\]\s*/, '').trim(); // strip "[code] "

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });
  const commit = new URL(req.url).searchParams.get('commit') === '1';

  // 1. Nappa products (SKU BND…)
  const prods = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', '=like', 'BND%']]],
    { fields: ['id', 'default_code', 'name', 'product_tmpl_id', 'weight'], limit: 300 }), 15000, 'prods');
  const nappa = prods.filter(p => parseSku(p.default_code));
  const prodIds = nappa.map(p => p.id);

  // 2. BoMs for those variants (latest per product) + their lines — batched (2 calls)
  const boms = await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [[['product_id', 'in', prodIds]]],
    { fields: ['id', 'product_id'], limit: 1000 }), 15000, 'boms');
  const bomByProd: Record<number, number> = {}; // product_id -> chosen (latest) bom id
  for (const b of boms.sort((a, z) => a.id - z.id)) {
    const pid = Array.isArray(b.product_id) ? b.product_id[0] : b.product_id;
    bomByProd[pid] = b.id; // later (higher id) wins
  }
  const bomIds = Array.from(new Set(Object.values(bomByProd)));
  const lines = bomIds.length ? await tmo(odooExecute<any[]>('mrp.bom.line', 'search_read',
    [[['bom_id', 'in', bomIds]]],
    { fields: ['bom_id', 'product_id', 'product_qty', 'product_uom_id'], limit: 3000 }), 15000, 'lines') : [];
  const linesByBom: Record<number, any[]> = {};
  for (const l of lines) {
    const bid = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id;
    (linesByBom[bid] ??= []).push(l);
  }

  // 3. Build the plan: one fiche per flavor, variants = sizes
  const SIZE_ORDER = ['D14', 'D16', 'D18', 'D20', 'D22', 'D24'];
  type V = { size: string; sku: string; weight: number; hasBom: boolean; ingredients: { name: string; qty: number; unit: string }[] };
  const plan: Record<string, { flavor: string; name: string; variants: V[] }> = {};
  for (const p of nappa) {
    const psd = parseSku(p.default_code)!;
    const key = psd.flavor;
    (plan[key] ??= { flavor: psd.flavor, name: `Bánh Nappa ${psd.flavor}`, variants: [] });
    const bomId = bomByProd[p.id];
    const ings = (bomId ? linesByBom[bomId] ?? [] : []).map(l => ({
      name: cleanName(Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id)),
      qty: l.product_qty,
      unit: Array.isArray(l.product_uom_id) ? l.product_uom_id[1] : 'kg',
    }));
    plan[key].variants.push({ size: psd.size, sku: p.default_code, weight: p.weight ?? 0, hasBom: !!bomId, ingredients: ings });
  }
  for (const k of Object.keys(plan)) plan[k].variants.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));

  const summary = {
    commit, family: 'Nappa', team_assumed: 'baby_mama', category: 'Birthday cake',
    flavors: Object.keys(plan).length,
    variants: nappa.length,
    variants_without_bom: nappa.filter(p => !bomByProd[p.id]).length,
  };
  if (!commit) return NextResponse.json({ dryRun: true, summary, plan });

  // 4. WRITE (idempotent): skip SKUs already present as a variant
  const allSkus = nappa.map(p => p.default_code);
  const { data: existing } = await supabase.from('lab_fiche_variants').select('sku').in('sku', allSkus);
  const existingSkus = new Set((existing ?? []).map((e: any) => e.sku));

  const created: any = { fiches: [], variants: 0, ingredients: 0, skipped_existing_skus: [] };
  for (const key of Object.keys(plan)) {
    const f = plan[key];
    const toAdd = f.variants.filter(v => !existingSkus.has(v.sku));
    if (!toAdd.length) { created.skipped_existing_skus.push(...f.variants.map(v => v.sku)); continue; }

    const { data: fiche, error: fErr } = await supabase.from('lab_fiche_meta').insert({
      name_vi: f.name, name_en: f.name, category: 'Birthday cake',
      teams: ['baby_mama'], is_active: true,
    }).select('id').single();
    if (fErr || !fiche) return NextResponse.json({ error: 'fiche insert: ' + fErr?.message, created }, { status: 500 });
    created.fiches.push({ name: f.name, id: fiche.id, variants: toAdd.length });

    for (let i = 0; i < toAdd.length; i++) {
      const v = toAdd[i];
      const { data: variant, error: vErr } = await supabase.from('lab_fiche_variants').insert({
        fiche_id: fiche.id, label: v.size, sku: v.sku, weight_g: v.weight ? Math.round(v.weight * 1000) : null,
        is_default: i === 0, sort_order: i,
      }).select('id').single();
      if (vErr || !variant) return NextResponse.json({ error: 'variant insert: ' + vErr?.message, created }, { status: 500 });
      created.variants++;
      if (v.ingredients.length) {
        const rows = v.ingredients.map((ing, idx) => ({
          fiche_id: fiche.id, variant_id: variant.id,
          ingredient_name: ing.name, quantity: ing.qty, unit: ing.unit, sort_order: idx,
        }));
        const { error: iErr } = await supabase.from('lab_fiche_ingredients').insert(rows);
        if (iErr) return NextResponse.json({ error: 'ingredients insert: ' + iErr.message, created }, { status: 500 });
        created.ingredients += rows.length;
      }
    }
  }
  return NextResponse.json({ committed: true, summary, created });
}
