import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// TEMP diagnostic — per-card detail of a day's production (done cards), to explain a
// "produced tomorrow" day and to shape the click-to-detail view. ?date=YYYY-MM-DD. Admin only.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const date = new URL(req.url).searchParams.get('date') || new Date().toISOString().split('T')[0];

  const { data: rows } = await supabase
    .from('lab_assignments')
    .select('id, product_name_vi, variant_label, team, total_qty, qty_produced, is_extra, produced_ahead, produced_by_name, produced_at, import_id, lab_imports!inner(delivery_date, status, order_number, type)')
    .eq('lab_imports.status', 'published')
    .eq('status', 'done')
    .eq('lab_imports.delivery_date', date)
    .order('team');

  const cards = (rows ?? []).map((a: any) => ({
    product: a.product_name_vi, variant: a.variant_label, team: a.team,
    qty: (a.qty_produced && a.qty_produced > 0) ? a.qty_produced : a.total_qty,
    is_extra: a.is_extra, produced_ahead: a.produced_ahead,
    produced_by: a.produced_by_name, produced_at: a.produced_at,
    import: `${a.lab_imports?.type ?? ''} #${a.lab_imports?.order_number ?? ''}`,
  }));
  const totalPieces = cards.reduce((s, c) => s + (c.qty ?? 0), 0);

  return NextResponse.json({
    date, cards_count: cards.length, total_pieces: totalPieces,
    produced_ahead_count: cards.filter(c => c.produced_ahead).length,
    cards,
  });
}
