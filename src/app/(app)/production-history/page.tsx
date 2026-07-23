import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { labDateOf } from '@/lib/odoo';
import ProductionHistoryView from './ProductionHistoryView';

export const revalidate = 0;

// Production history: per-day recap of everything produced (chefs' "Done" tabs),
// exportable to Odoo at any time — so a forgotten day can still be exported later.
// Read-only, lightweight aggregation (minimal columns, bounded to recent days).
export default async function ProductionHistoryPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  // Last ~120 days of published imports — enough to catch any missed export,
  // small enough to stay negligible on bandwidth.
  const from = new Date();
  from.setDate(from.getDate() - 120);
  const fromDate = from.toISOString().split('T')[0];

  const { data: rows } = await supabase
    .from('lab_assignments')
    .select('qty_produced, total_qty, cancelled, is_extra, produced_at, lab_imports!inner(delivery_date, status)')
    .eq('lab_imports.status', 'published')
    .eq('status', 'done')
    .gte('lab_imports.delivery_date', fromDate)
    .limit(8000);

  // Aggregate per PRODUCTION day (produced_at) — an item made ahead of time counts on the day
  // it was physically produced, not its delivery day. Fallback to delivery_date if no timestamp.
  const byDay = new Map<string, { date: string; pieces: number; cards: number; extras: number }>();
  for (const a of rows ?? []) {
    if (a.cancelled) continue;
    const date = labDateOf((a as any).produced_at) ?? (a as any).lab_imports?.delivery_date;
    if (!date) continue;
    const qty = (a.qty_produced && a.qty_produced > 0) ? a.qty_produced : (a.total_qty ?? 0);
    const cur = byDay.get(date) ?? { date, pieces: 0, cards: 0, extras: 0 };
    cur.pieces += qty;
    cur.cards += 1;
    if (a.is_extra) cur.extras += 1;
    byDay.set(date, cur);
  }

  const days = Array.from(byDay.values()).sort((a, b) => b.date.localeCompare(a.date));
  const today = new Date().toISOString().split('T')[0];

  return <ProductionHistoryView days={days} today={today} />;
}
