import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { foldSearch, rankFiches, type SearchFiche } from './match';

// Large enough to show a whole category (the biggest, Birthday cake, has ~75 active cards). The
// old cap of 30 silently hid the end of the alphabet: typing "macaron" matched 42 cards and
// dropped the last 12, which were exactly the new flavours (Axel, 2026-10-07: "ils ont pas tous
// les produits notamment new macaron et new entremet").
const MAX_RESULTS = 80;

// Every signed-in user reads the same recipe cards (RLS: select true), so the list is kept for a
// minute per server instance instead of being re-read on every keystroke of every screen.
let ficheCache: { at: number; rows: SearchFiche[] } | null = null;
const CACHE_MS = 60_000;

// Search LAB FICHES only — the B2C catalogue is never read.
// Result shape kept compatible with the station "extra product" modal:
// id = fiche_id, variant_id = default variant, main_image_url = fiche image.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q        = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  const team     = req.nextUrl.searchParams.get('team')?.trim() ?? '';
  const category = req.nextUrl.searchParams.get('category')?.trim() ?? '';
  // Opt-in (station "extra production" modal only, Axel 2026-10-01: "enlève les produits qui sont
  // déclarés comme inactif dans l'app"): hide variants switched off in /admin/fiches
  // (lab_fiche_variants.is_active, lab_v80) and fiches whose variants are ALL inactive. Other
  // callers (inventory, lab scrap, shop) keep the full list on purpose — they may still need to
  // count or scrap an old product that's still physically in stock.
  const activeOnly = req.nextUrl.searchParams.get('activeOnly') === '1';

  if (q.length < 1 && !category) return NextResponse.json([]);

  let all: SearchFiche[];
  if (ficheCache && Date.now() - ficheCache.at < CACHE_MS) {
    all = ficheCache.rows;
  } else {
    const { data, error } = await supabase
      .from('lab_fiche_meta')
      .select('id, name_vi, name_en, category, image_url, teams')
      .eq('is_active', true)
      .order('name_vi')
      .limit(1000);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    all = (data ?? []) as SearchFiche[];
    if (all.length) ficheCache = { at: Date.now(), rows: all };
  }

  let candidates = category ? all.filter(f => f.category === category) : all;

  if (team) {
    // Fiches tagged with this team OR already produced by this team in the past
    const { data: teamAssignments } = await supabase
      .from('lab_assignments')
      .select('fiche_id')
      .eq('team', team)
      .not('fiche_id', 'is', null)
      .limit(1000);
    const ficheIdsForTeam = new Set((teamAssignments ?? []).map((a: any) => a.fiche_id as string));
    candidates = candidates.filter(f => (Array.isArray(f.teams) && f.teams.includes(team)) || ficheIdsForTeam.has(f.id));
  }

  // A SKU typed as is ("BMCRCC") finds its recipe card too.
  const skuHits = new Set<string>();
  if (/^[A-Za-z0-9.-]{2,}$/.test(q)) {
    const { data: skuRows } = await supabase
      .from('lab_fiche_variants').select('fiche_id').ilike('sku', `%${q}%`).limit(300);
    for (const r of skuRows ?? []) skuHits.add((r as any).fiche_id as string);
  }

  const ranked = q.length >= 1 ? rankFiches(candidates, foldSearch(q), skuHits) : candidates;
  const total = ranked.length;
  const fiches = ranked.slice(0, MAX_RESULTS);

  // All variants per fiche (default first) — so extra production can target a specific
  // variant, not only the default one.
  const ficheIds = (fiches ?? []).map(f => f.id);
  const { data: variants } = ficheIds.length
    ? await supabase
        .from('lab_fiche_variants')
        .select('id, fiche_id, sku, label, image_url, is_default, sort_order, weight_g, is_active')
        .in('fiche_id', ficheIds)
        .order('is_default', { ascending: false })
        .order('sort_order')
    : { data: [] as any[] };

  // weight_g (2026-08-21) — surfaced so the station "extra production" modal can let a chef
  // enter a produced WEIGHT instead of a unit count for weight-based products (Biscuit Voyage),
  // converting to a floored unit count client-side. Purely additive — every other caller of this
  // route (inventory add-product, etc.) already ignores unknown fields.
  const variantsByFiche: Record<string, { id: string; sku: string | null; label: string; image_url: string | null; weight_g: number | null }[]> = {};
  const fichesWithVariantRows = new Set<string>();
  for (const v of variants ?? []) {
    fichesWithVariantRows.add(v.fiche_id);
    if (activeOnly && v.is_active === false) continue;
    (variantsByFiche[v.fiche_id] ??= []).push({
      id: v.id, sku: v.sku ?? null, label: v.label ?? 'Standard', image_url: v.image_url ?? null, weight_g: v.weight_g ?? null,
    });
  }

  // A fiche with variant rows but none active is "inactive" (same rule as /admin/fiches); a fiche
  // with no variant rows at all is kept, exactly as before.
  const visibleFiches = activeOnly
    ? (fiches ?? []).filter(f => !fichesWithVariantRows.has(f.id) || (variantsByFiche[f.id]?.length ?? 0) > 0)
    : (fiches ?? []);

  const results = visibleFiches.map(f => {
    const vs = variantsByFiche[f.id] ?? [];
    const dv = vs[0] ?? null; // default variant (is_default first)
    return {
      id: f.id,
      name_vi: f.name_vi,
      name_en: f.name_en ?? null,
      sku: dv?.sku ?? null,
      variant_id: dv?.id ?? null,
      main_image_url: dv?.image_url ?? f.image_url ?? null,
      variants: vs,
      is_lab_only: true,
      category_id: f.category ?? null,
      subcategory: f.category ?? null,
    };
  });

  return NextResponse.json(results, { headers: { 'x-total-count': String(total) } });
}
