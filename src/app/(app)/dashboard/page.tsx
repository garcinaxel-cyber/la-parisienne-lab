import { createClient } from '@/lib/supabase-server';
import DashboardView from '@/components/DashboardView';

export const revalidate = 60; // refresh every 60s max — saves bandwidth

export default async function DashboardPage() {
  const supabase = createClient();
  const today = new Date().toISOString().split('T')[0];
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
  const tomorrow = tmr.toISOString().split('T')[0];

  // Load a day's assignments + order lines (assistants' by-team and by-order views)
  async function loadDay(date: string) {
    const { data: asg } = await supabase.from('lab_assignments')
      .select('id,team,product_name_vi,variant_label,total_qty,qty_produced,status,produced_ahead,cancelled,import_id,lab_imports!inner(delivery_date,order_number,status)')
      .eq('lab_imports.status', 'published')
      .eq('lab_imports.delivery_date', date)
      .order('team').order('sort_order').limit(500);
    const importIds = Array.from(new Set((asg ?? []).map((a: any) => a.import_id)));
    const { data: ol } = importIds.length
      ? await supabase.from('lab_order_lines')
          .select('import_id, team, variant_label, shop_name, qty, order_ref, product_name_vi, delivery_time')
          .in('import_id', importIds).limit(1000)
      : { data: [] as any[] };
    return { assignments: asg ?? [], orderLines: ol ?? [] };
  }

  const [{ data: stats }, { data: imports }, todayData, tomorrowData, { data: pendingChangesRaw }, { data: excludedRows }] = await Promise.all([
    supabase.rpc('lab_dashboard_stats', { p_date: today }),
    supabase.from('lab_imports').select('id,delivery_date,order_number,type,status,shipped_from_lab,imported_at')
      .gte('delivery_date', today).order('delivery_date').order('order_number').limit(10),
    loadDay(today),
    loadDay(tomorrow),
    supabase.from('lab_odoo_changes').select('order_ref, cancelled, items, delivery_date')
      .eq('status', 'pending').order('detected_at', { ascending: false }).limit(50),
    supabase.from('lab_excluded_skus').select('sku'),
  ]);

  const { count: pendingTransfers } = await supabase
    .from('lab_stock_transfers').select('*', { count: 'exact', head: true }).eq('status', 'pending');

  // Hide already-excluded SKUs (packaging, drinks…) from the changes banner; drop empty rows.
  const excludedSet = new Set((excludedRows ?? []).map((r: any) => r.sku));
  const pendingChanges = (pendingChangesRaw ?? [])
    .map((ch: any) => ({ ...ch, items: (ch.items ?? []).filter((it: any) => !excludedSet.has(it.sku)) }))
    .filter((ch: any) => ch.items.length > 0);

  return <DashboardView stats={stats} imports={imports ?? []}
    assignments={todayData.assignments} orderLines={todayData.orderLines}
    tomorrowAssignments={tomorrowData.assignments} tomorrowOrderLines={tomorrowData.orderLines}
    pendingChanges={pendingChanges} pendingTransfers={pendingTransfers ?? 0} today={today} tomorrow={tomorrow} />;
}
