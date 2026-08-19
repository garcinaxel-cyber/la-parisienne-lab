import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import DeliveryCheckHistoryView from './DeliveryCheckHistoryView';

export const revalidate = 0;

// Same lab-local (Asia/Ho_Chi_Minh) day boundary as the main delivery-check page — the
// history window is the 7 days strictly BEFORE today (today/tomorrow already live on the
// main page, no need to duplicate them here).
function labHistoryWindow(): { today: string; start: string; end: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const start = fmt.format(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
  const end = fmt.format(new Date(now.getTime() - 1 * 24 * 3600 * 1000));
  return { today, start, end };
}

export default async function DeliveryCheckHistoryPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { start, end } = labHistoryWindow();

  // Purely a read of what already exists — a "history" view only ever shows orders someone
  // actually opened/checked (i.e. that already have a lab_delivery_orders header). Nothing here
  // creates or modifies data, unlike the main /delivery-check page which builds the checklist.
  const { data: headers } = await supabase.from('lab_delivery_orders')
    .select('id, order_ref, delivery_date, shop_name, status, printed_at, odoo_push_status')
    .gte('delivery_date', start).lte('delivery_date', end)
    .order('delivery_date', { ascending: false }).order('order_ref');

  const headerIds = (headers ?? []).map(h => h.id);
  const { data: checkLines } = headerIds.length
    ? await supabase.from('lab_delivery_check_lines').select('delivery_order_id, qty_checked').in('delivery_order_id', headerIds)
    : { data: [] as any[] };
  const linesByHeader: Record<string, { total: number; checked: number }> = {};
  for (const l of checkLines ?? []) {
    const e = linesByHeader[l.delivery_order_id] ??= { total: 0, checked: 0 };
    e.total++; if (l.qty_checked != null) e.checked++;
  }

  const orders = (headers ?? []).map(h => ({
    id: h.id, order_ref: h.order_ref, delivery_date: h.delivery_date, shop_name: h.shop_name,
    status: h.status, printed_at: h.printed_at, odoo_push_status: h.odoo_push_status,
    checked: linesByHeader[h.id]?.checked ?? 0, total: linesByHeader[h.id]?.total ?? 0,
  }));

  return <DeliveryCheckHistoryView orders={orders} start={start} end={end} />;
}
