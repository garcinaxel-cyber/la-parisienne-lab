import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { ensureDeliveryOrderChecklist } from '@/lib/delivery-check';
import DeliveryCheckCategoryView from './DeliveryCheckCategoryView';

export const revalidate = 0;

function labTodayTomorrow(): [string, string] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const tomorrow = fmt.format(new Date(now.getTime() + 24 * 3600 * 1000));
  return [today, tomorrow];
}

export default async function DeliveryCheckCategoryPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [today, tomorrow] = labTodayTomorrow();

  const { data: imports } = await supabase.from('lab_imports')
    .select('id').in('delivery_date', [today, tomorrow]).eq('status', 'published');
  const importIds = (imports ?? []).map((i: any) => i.id);

  const { data: orderLines } = importIds.length
    ? await supabase.from('lab_order_lines').select('order_ref, delivery_date').in('import_id', importIds)
    : { data: [] as any[] };

  // 100%-packaging orders (nothing in lab_order_lines — e.g. a pure supplies-restock
  // replenishment) only live in lab_order_packaging_lines — union both so they still show up
  // here instead of being invisible (2026-08-10, REP/2026/01003).
  const { data: packagingOnlyLines } = await supabase.from('lab_order_packaging_lines')
    .select('order_ref, delivery_date').in('delivery_date', [today, tomorrow]);

  const orderKeys = Array.from(new Set([
    ...(orderLines ?? []).map((l: any) => `${l.delivery_date}||${l.order_ref}`),
    ...(packagingOnlyLines ?? []).map((l: any) => `${l.delivery_date}||${l.order_ref}`),
  ])).map(k => { const [delivery_date, order_ref] = k.split('||'); return { delivery_date, order_ref }; });

  // Materialize every order's check lines in parallel (same function the per-order screen
  // uses — one source of truth, this view is just a different grouping of the same rows).
  const results = await Promise.all(orderKeys.map(async o => {
    try { return await ensureDeliveryOrderChecklist(supabase, o.delivery_date, o.order_ref); }
    catch { return null; }
  }));

  type Row = {
    sku: string | null; product_name_vi: string; product_name_en: string | null;
    category: string; product_category: string | null; team: string | null; order_ref: string; shop_name: string | null;
    delivery_date: string; qty_expected: number; qty_checked: number | null; status: string;
    id: string; discrepancy_reason: string | null; discrepancy_note: string | null;
  };
  const rows: Row[] = [];
  for (const r of results) {
    if (!r) continue;
    for (const l of r.lines) {
      rows.push({
        id: l.id, sku: l.sku, product_name_vi: l.product_name_vi, product_name_en: l.product_name_en,
        category: l.category, product_category: l.product_category, team: l.team,
        order_ref: r.header.order_ref, shop_name: r.header.shop_name,
        delivery_date: r.header.delivery_date, qty_expected: l.qty_expected, qty_checked: l.qty_checked,
        status: l.status, discrepancy_reason: l.discrepancy_reason, discrepancy_note: l.discrepancy_note,
      });
    }
  }

  return <DeliveryCheckCategoryView rows={rows} today={today} tomorrow={tomorrow} />;
}
