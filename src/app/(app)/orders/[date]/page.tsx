import { createClient } from '@/lib/supabase-server';
import OrderReviewView from './OrderReviewView';

export const revalidate = 30;

export default async function OrderDatePage({ params }: { params: { date: string } }) {
  const supabase = createClient();
  const { date } = params;

  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id, delivery_date, order_number, type, status, shipped_from_lab, notes, imported_at, published_at')
    .eq('delivery_date', date)
    .order('order_number');

  const importIds = (imports ?? []).map((i: any) => i.id);

  const [assignmentsResult, orderLinesResult, userResult] = await Promise.all([
    importIds.length > 0
      ? supabase
          .from('lab_assignments')
          .select(`
            id, team, product_name_vi, product_name_en, image_url,
            variant_label, total_qty, qty_to_produce, qty_produced,
            status, exception_reason, notes, sort_order, import_id
          `)
          .in('import_id', importIds)
          .order('team').order('sort_order')
      : Promise.resolve({ data: [] }),
    // lab_order_lines is used for per-client breakdown display (managers can read it)
    importIds.length > 0
      ? supabase
          .from('lab_order_lines')
          .select('import_id, team, variant_label, shop_name, qty, order_ref')
          .in('import_id', importIds)
          .order('shop_name')
      : Promise.resolve({ data: [] }),
        supabase.auth.getSession(),
  ]);

  // Fetch breakdown separately (requires lab_v3.sql — safe fallback if not run)
  const assignmentIds = (assignmentsResult.data ?? []).map((a: any) => a.id);
  const { data: breakdowns } = assignmentIds.length > 0
    ? await supabase.from('lab_assignments').select('id, breakdown').in('id', assignmentIds)
    : { data: [] as any[] };
  const breakdownMap: Record<string, any[]> = {};
  for (const b of breakdowns ?? []) breakdownMap[b.id] = Array.isArray(b.breakdown) ? b.breakdown : [];

  const assignments = (assignmentsResult.data ?? []).map((a: any) => ({
    ...a, breakdown: breakdownMap[a.id] ?? [],
  }));

    const profile = userResult.data.session
        ? (await supabase.from('profiles').select('role').eq('id', userResult.data.session.user.id).single()).data
    : null;

  return (
    <OrderReviewView
      date={date}
      imports={imports ?? []}
      assignments={assignments}
      orderLines={orderLinesResult.data ?? []}
      userRole={profile?.role ?? null}
    />
  );
}
