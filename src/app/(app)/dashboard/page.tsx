import { createClient } from '@/lib/supabase-server';
import DashboardView from '@/components/DashboardView';

export const revalidate = 60; // refresh every 60s max â saves bandwidth

export default async function DashboardPage() {
  const supabase = createClient();
  const today = new Date().toISOString().split('T')[0];

  const [{ data: stats }, { data: imports }, { data: recentAssignments }] = await Promise.all([
    supabase.rpc('lab_dashboard_stats', { p_date: today }),
    supabase.from('lab_imports').select('id,delivery_date,order_number,type,status,shipped_from_lab,imported_at')
      .gte('delivery_date', today).order('delivery_date').order('order_number').limit(10),
    // Only fetch snapshots â no JOIN with products (bandwidth optimised)
    supabase.from('lab_assignments')
      .select('id,team,product_name_vi,variant_label,total_qty,qty_produced,status,import_id,lab_imports!inner(delivery_date,order_number,status)')
      .eq('lab_imports.status', 'published')
      .eq('lab_imports.delivery_date', today)
      .order('team').order('sort_order')
      .limit(500),
  ]);

  return <DashboardView stats={stats} imports={imports ?? []} assignments={recentAssignments ?? []} today={today} />;
}
