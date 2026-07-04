import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

// Search LAB FICHES only — the B2C catalogue is never read.
// Result shape kept compatible with the station "extra product" modal:
// id = fiche_id, variant_id = default variant, main_image_url = fiche image.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q        = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  const team     = req.nextUrl.searchParams.get('team')?.trim() ?? '';
  const category = req.nextUrl.searchParams.get('category')?.trim() ?? '';

  if (q.length < 1 && !category) return NextResponse.json([]);

  let query = supabase
    .from('lab_fiche_meta')
    .select('id, name_vi, name_en, category, image_url, teams')
    .eq('is_active', true)
    .order('name_vi')
    .limit(30);

  if (q.length >= 1) {
    query = query.or(`name_vi.ilike.%${q}%,name_en.ilike.%${q}%`);
  }
  if (category) {
    query = query.eq('category', category);
  }
  if (team) {
    // Fiches tagged with this team OR already produced by this team in the past
    const { data: teamAssignments } = await supabase
      .from('lab_assignments')
      .select('fiche_id')
      .eq('team', team)
      .not('fiche_id', 'is', null)
      .limit(1000);
    const ficheIdsForTeam = Array.from(new Set((teamAssignments ?? []).map((a: any) => a.fiche_id as string)));
    if (ficheIdsForTeam.length > 0) {
      query = query.or(`teams.cs.{${team}},id.in.(${ficheIdsForTeam.join(',')})`);
    } else {
      query = query.contains('teams', [team]);
    }
  }

  const { data: fiches, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Default variant per fiche (for SKU + variant_id + per-variant photo)
  const ficheIds = (fiches ?? []).map(f => f.id);
  const { data: variants } = ficheIds.length
    ? await supabase
        .from('lab_fiche_variants')
        .select('id, fiche_id, sku, image_url, is_default, sort_order')
        .in('fiche_id', ficheIds)
        .order('is_default', { ascending: false })
        .order('sort_order')
    : { data: [] as any[] };

  const defaultVariant: Record<string, { id: string; sku: string | null; image_url: string | null }> = {};
  for (const v of variants ?? []) {
    if (!defaultVariant[v.fiche_id]) {
      defaultVariant[v.fiche_id] = { id: v.id, sku: v.sku ?? null, image_url: v.image_url ?? null };
    }
  }

  const results = (fiches ?? []).map(f => {
    const dv = defaultVariant[f.id] ?? null;
    return {
      id: f.id,
      name_vi: f.name_vi,
      name_en: f.name_en ?? null,
      sku: dv?.sku ?? null,
      variant_id: dv?.id ?? null,
      main_image_url: dv?.image_url ?? f.image_url ?? null,
      is_lab_only: true,
      category_id: f.category ?? null,
      subcategory: f.category ?? null,
    };
  });

  return NextResponse.json(results);
}
