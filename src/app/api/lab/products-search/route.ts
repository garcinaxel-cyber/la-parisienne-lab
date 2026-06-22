import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 1) return NextResponse.json([]);

  const { data } = await supabase
    .from('products')
    .select('id, name_vi, name_en, sku, main_image_url, is_lab_only')
    .or(`name_vi.ilike.%${q}%,name_en.ilike.%${q}%,sku.ilike.%${q}%`)
    .eq('is_active', true)
    .order('name_vi')
    .limit(15);

  return NextResponse.json(data ?? []);
}
