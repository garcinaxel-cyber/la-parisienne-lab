import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

// Read-only sanity check for the production export: returns the same "Done"-tab
// scope (status=done, not cancelled, all teams, extra included) as a JSON
// breakdown so the produced total for a day can be verified. Temporary helper.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const today = new Date().toISOString().split('T')[0];
  const date = (req.nextUrl.searchParams.get('date') || today).slice(0, 10);

  const { data: asg, error } = await supabase
    .from('lab_assignments')
    .select('team, product_name_vi, total_qty, qty_produced, status, cancelled, is_extra, lab_imports!inner(delivery_date,status)')
    .eq('lab_imports.status', 'published')
    .eq('lab_imports.delivery_date', date)
    .eq('status', 'done')
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const done = (asg ?? []).filter((a: any) => !a.cancelled);
  const qOf = (a: any) => (a.qty_produced && a.qty_produced > 0) ? a.qty_produced : (a.total_qty ?? 0);

  const byTeam: Record<string, { cards: number; qty: number }> = {};
  const items: { name: string; team: string; qty: number; is_extra: boolean }[] = [];
  let total = 0;
  for (const a of done) {
    const q = qOf(a);
    total += q;
    byTeam[a.team] = byTeam[a.team] ?? { cards: 0, qty: 0 };
    byTeam[a.team].cards += 1;
    byTeam[a.team].qty += q;
    items.push({ name: a.product_name_vi ?? '', team: a.team, qty: q, is_extra: !!a.is_extra });
  }

  return NextResponse.json({
    date,
    done_cards: done.length,
    total_pieces: total,
    extra_cards: done.filter((a: any) => a.is_extra).length,
    by_team: byTeam,
    items: items.sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)),
  });
}
