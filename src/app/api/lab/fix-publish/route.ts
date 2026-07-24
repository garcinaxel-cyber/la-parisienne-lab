import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// TEMP one-time repair — in AUTO-publish mode every line of a PUBLISHED import must be
// published (a line left at false/null shows a phantom "order not published" and can hide a
// portion from the chefs). Publishes those lines for today + future. Dry-run default; ?commit=1.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const commit = new URL(req.url).searchParams.get('commit') === '1';
  const today = new Date().toISOString().split('T')[0];

  // Published imports (today + future)
  const { data: imps } = await supabase.from('lab_imports')
    .select('id').eq('status', 'published').gte('delivery_date', today);
  const importIds = (imps ?? []).map((i: any) => i.id);
  if (!importIds.length) return NextResponse.json({ published_imports: 0, to_fix: 0 });

  // Lines of those imports that are NOT published (false or null)
  const { data: falseLines } = await supabase.from('lab_order_lines')
    .select('id, order_ref, published').in('import_id', importIds).neq('published', true);
  const { data: nullLines } = await supabase.from('lab_order_lines')
    .select('id, order_ref, published').in('import_id', importIds).is('published', null);
  const all = [...(falseLines ?? []), ...(nullLines ?? [])];
  const ids = Array.from(new Set(all.map((l: any) => l.id)));
  const refs = Array.from(new Set(all.map((l: any) => l.order_ref)));

  if (!commit) return NextResponse.json({ published_imports: importIds.length, to_fix: ids.length, order_refs: refs });

  let fixed = 0;
  if (ids.length) {
    const { error, count } = await supabase.from('lab_order_lines')
      .update({ published: true, published_at: new Date().toISOString(), published_by: session.user.id }, { count: 'exact' })
      .in('id', ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    fixed = count ?? ids.length;
  }
  return NextResponse.json({ committed: true, fixed, order_refs: refs });
}
