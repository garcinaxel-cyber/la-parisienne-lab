import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q          = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  const team       = req.nextUrl.searchParams.get('team')?.trim() ?? '';
  const categoryId = req.nextUrl.searchParams.get('category')?.trim() ?? '';

  if (q.length < 1 && !categoryId) return NextResponse.json([]);

  // If team is specified, restrict to product_ids that have been assigned to that team
  let allowedProductIds: string[] | null = null;
  if (team) {
    const { data: assignments } = await supabase
      .from('lab_assignments')
      .select('product_id')
      .eq('team', team)
      .not('product_id', 'is', null);
    allowedProductIds = [...new Set((assignments ?? []).map((a: any) => a.product_id as string))];
    // If the team has never had any assignments, return nothing
    if (allowedProductIds.length === 0) return NextResponse.json([]);
  }

  let query = supabase
    .from('products')
    .select('id, name_vi, name_en, sku, main_image_url, is_lab_only, category_id, subcategory')
    .eq('is_active', true)
    .order('name_vi')
    .limit(30);

  if (q.length >= 1) {
    query = query.or(`name_vi.ilike.%${q}%,name_en.ilike.%${q}%,sku.ilike.%${q}%`);
  }
  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }
  if (allowedProductIds) {
    query = query.in('id', allowedProductIds);
  }

  const { data } = await query;
  return NextResponse.json(data ?? []);
}
