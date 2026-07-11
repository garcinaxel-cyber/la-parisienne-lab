import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import BirthdayCakesView from './BirthdayCakesView';

export const revalidate = 0;

export default async function BirthdayCakesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const today = new Date().toISOString().split('T')[0];

  // 1. Which fiches are birthday cakes (by product category on the recipe card)
  const { data: bcFiches } = await supabase
    .from('lab_fiche_meta').select('id').eq('category', 'Birthday cake');
  const bcFicheIds = (bcFiches ?? []).map(f => f.id);

  // 2. READ the already-imported order lines for those fiches (upcoming) — no new order is created
  const { data: lines } = bcFicheIds.length
    ? await supabase.from('lab_order_lines')
        .select('id, order_ref, product_name_vi, shop_name, delivery_date, delivery_time, qty, product_sku, source_type')
        .in('fiche_id', bcFicheIds)
        .gte('delivery_date', today)
        .order('delivery_date').order('delivery_time')
    : { data: [] as any[] };

  // 3. Attach the complementary info (message / ready time / who delivers)
  const lineIds = (lines ?? []).map(l => l.id);
  const { data: details } = lineIds.length
    ? await supabase.from('lab_birthday_details')
        .select('order_line_id, message, ready_time, delivered_by').in('order_line_id', lineIds)
    : { data: [] as any[] };
  const byLine: Record<string, any> = {};
  for (const d of details ?? []) byLine[d.order_line_id] = d;

  const cakes = (lines ?? []).map(l => ({
    id: l.id,
    order_ref: l.order_ref,
    name: l.product_name_vi,
    shop: l.shop_name,
    delivery_date: l.delivery_date,
    delivery_time: l.delivery_time,
    qty: l.qty,
    message: byLine[l.id]?.message ?? '',
    ready_time: byLine[l.id]?.ready_time ?? '',
    delivered_by: byLine[l.id]?.delivered_by ?? '',
  }));

  return <BirthdayCakesView cakes={cakes} />;
}
