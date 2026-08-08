import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import DeliveryCheckIndexView from './DeliveryCheckIndexView';

export const revalidate = 0;

// Lab-local (Asia/Ho_Chi_Minh) today + tomorrow, matching the paper workflow: assistants
// check what was produced yesterday for today's delivery, and print tomorrow's bons ahead.
function labTodayTomorrow(): [string, string] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const tomorrow = fmt.format(new Date(now.getTime() + 24 * 3600 * 1000));
  return [today, tomorrow];
}

export default async function DeliveryCheckPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [today, tomorrow] = labTodayTomorrow();

  const { data: imports } = await supabase.from('lab_imports')
    .select('id, delivery_date, status').in('delivery_date', [today, tomorrow]).eq('status', 'published');
  const importIds = (imports ?? []).map((i: any) => i.id);

  const { data: orderLines } = importIds.length
    ? await supabase.from('lab_order_lines')
        .select('order_ref, delivery_date, shop_name, qty')
        .in('import_id', importIds)
    : { data: [] as any[] };

  type Row = { order_ref: string; delivery_date: string; shop_name: string; lineCount: number };
  const byKey: Record<string, Row> = {};
  for (const l of orderLines ?? []) {
    const key = `${l.delivery_date}||${l.order_ref}`;
    (byKey[key] ??= { order_ref: l.order_ref, delivery_date: l.delivery_date, shop_name: l.shop_name, lineCount: 0 }).lineCount++;
  }
  const orders = Object.values(byKey).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date) || a.order_ref.localeCompare(b.order_ref));

  // Progress: any lab_delivery_orders header already started for these (date, ref)
  const { data: headers } = orders.length
    ? await supabase.from('lab_delivery_orders')
        .select('id, order_ref, delivery_date, status')
        .in('delivery_date', [today, tomorrow])
    : { data: [] as any[] };
  const headerByKey: Record<string, { id: string; status: string }> = {};
  for (const h of headers ?? []) headerByKey[`${h.delivery_date}||${h.order_ref}`] = { id: h.id, status: h.status };
  const headerIds = (headers ?? []).map((h: any) => h.id);

  // Lines checked so far, to show an "X/Y" progress badge without opening the order
  const { data: checkLines } = headerIds.length
    ? await supabase.from('lab_delivery_check_lines').select('delivery_order_id, qty_checked').in('delivery_order_id', headerIds)
    : { data: [] as any[] };
  const linesByHeader: Record<string, { total: number; checked: number }> = {};
  for (const l of checkLines ?? []) {
    const e = linesByHeader[l.delivery_order_id] ??= { total: 0, checked: 0 };
    e.total++; if (l.qty_checked != null) e.checked++;
  }

  // Pending manual cakes (3rd panier) for the badge count
  const { data: pendingCakes } = await supabase.from('lab_manual_cakes')
    .select('id').in('delivery_date', [today, tomorrow]).is('matched_order_ref', null).is('cancelled_at', null);

  const ordersWithProgress = orders.map(o => {
    const key = `${o.delivery_date}||${o.order_ref}`;
    const h = headerByKey[key];
    const counts = h ? linesByHeader[h.id] : undefined;
    return {
      ...o,
      status: h?.status ?? 'not_started',
      checked: counts?.checked ?? 0,
      total: counts?.total ?? o.lineCount,
    };
  });

  return (
    <DeliveryCheckIndexView
      today={today}
      orders={ordersWithProgress}
      pendingCakesCount={(pendingCakes ?? []).length}
    />
  );
}
