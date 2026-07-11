import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// TEMPORARY debug — runs the birthday-cakes page query under the caller's own session
// to see what it actually returns (role, today, counts). Removed after diagnosis.
export async function GET() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const { data: profile } = session
    ? await supabase.from('profiles').select('role').eq('id', session.user.id).single()
    : { data: null };

  const today = new Date().toISOString().split('T')[0];
  const { data: bcFiches } = await supabase.from('lab_fiche_meta').select('id').eq('category', 'Birthday cake');
  const ids = (bcFiches ?? []).map(f => f.id);
  const { data: lines, error } = ids.length
    ? await supabase.from('lab_order_lines')
        .select('id, order_ref, product_name_vi, delivery_date, fiche_id')
        .in('fiche_id', ids).gte('delivery_date', today).limit(50)
    : { data: [], error: null };

  return NextResponse.json({
    authed: !!session,
    role: profile?.role ?? null,
    today,
    bcFicheCount: ids.length,
    lineCount: (lines ?? []).length,
    sample: (lines ?? []).slice(0, 5),
    error: error?.message ?? null,
  });
}
