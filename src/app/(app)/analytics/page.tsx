import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import AnalyticsView from './AnalyticsView';

export const revalidate = 300; // 5 min cache — analytics don't need to be real-time

export default async function AnalyticsPage({ searchParams }: { searchParams: { range?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  const days = searchParams.range === '7' ? 7 : searchParams.range === '90' ? 90 : 30;
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - days + 1);
  const fromStr = from.toISOString().split('T')[0];
  const toStr = today.toISOString().split('T')[0];

  // Published imports in range
  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id, delivery_date')
    .eq('status', 'published')
    .gte('delivery_date', fromStr)
    .lte('delivery_date', toStr);
  const importIds = (imports ?? []).map((i: any) => i.id);
  const dateByImport: Record<string, string> = {};
  for (const i of imports ?? []) dateByImport[i.id] = i.delivery_date;

  const { data: assignments } = importIds.length
    ? await supabase
        .from('lab_assignments')
        .select('import_id, team, product_name_vi, total_qty, qty_produced, status, blocked_reason')
        .in('import_id', importIds)
        .limit(20000)
    : { data: [] as any[] };

  const rows = (assignments ?? []) as any[];
  const isDone = (s: string) => s === 'done' || s === 'skip';

  // KPIs
  let unitsProduced = 0, unitsPlanned = 0, doneCards = 0, blockedCards = 0;
  const perTeam: Record<string, { total: number; done: number; units: number }> = {};
  const perProduct: Record<string, number> = {};
  const perReason: Record<string, number> = {};
  const perDay: Record<string, { units: number; total: number; done: number }> = {};

  for (const a of rows) {
    const date = dateByImport[a.import_id];
    unitsPlanned += a.total_qty ?? 0;
    unitsProduced += (isDone(a.status) ? (a.total_qty ?? 0) : (a.qty_produced ?? 0));
    if (isDone(a.status)) doneCards++;
    if (a.status === 'blocked') {
      blockedCards++;
      const r = a.blocked_reason || 'Autre';
      perReason[r] = (perReason[r] ?? 0) + 1;
    }
    const t = a.team || 'other';
    (perTeam[t] ??= { total: 0, done: 0, units: 0 });
    perTeam[t].total++; if (isDone(a.status)) perTeam[t].done++; perTeam[t].units += a.total_qty ?? 0;
    perProduct[a.product_name_vi] = (perProduct[a.product_name_vi] ?? 0) + (a.total_qty ?? 0);
    if (date) {
      (perDay[date] ??= { units: 0, total: 0, done: 0 });
      perDay[date].units += a.total_qty ?? 0;
      perDay[date].total++;
      if (isDone(a.status)) perDay[date].done++;
    }
  }

  const totalCards = rows.length;
  const kpis = {
    unitsProduced,
    unitsPlanned,
    completion: totalCards ? Math.round(doneCards / totalCards * 100) : 0,
    orders: new Set(rows.map(a => a.import_id)).size, // published imports in range
    blocked: blockedCards,
  };
  const teams = Object.entries(perTeam).map(([team, v]) => ({
    team, completion: v.total ? Math.round(v.done / v.total * 100) : 0, units: v.units,
  })).sort((a, b) => b.units - a.units);
  const topProducts = Object.entries(perProduct).map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty).slice(0, 8);
  const reasons = Object.entries(perReason).map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const daily = Object.entries(perDay).map(([date, v]) => ({
    date, units: v.units, total: v.total, done: v.done,
    completion: v.total ? Math.round(v.done / v.total * 100) : 0,
  })).sort((a, b) => a.date.localeCompare(b.date));

  return <AnalyticsView days={days} kpis={kpis} teams={teams} topProducts={topProducts} reasons={reasons} daily={daily} />;
}
