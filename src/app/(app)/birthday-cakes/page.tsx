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
  // …and their SKUs — so a line still matches even if its fiche_id wasn't set at import
  // (product got its recipe card AFTER the order was imported → line.fiche_id stays null).
  const { data: bcVariants } = bcFicheIds.length
    ? await supabase.from('lab_fiche_variants').select('sku').in('fiche_id', bcFicheIds)
    : { data: [] as any[] };
  const bcSkus = Array.from(new Set((bcVariants ?? []).map((v: any) => v.sku).filter(Boolean)));

  // 2. READ the already-imported order lines (upcoming) — matched by fiche_id OR by SKU.
  const lineCols = 'id, order_ref, product_name_vi, shop_name, delivery_date, delivery_time, qty, product_sku, source_type';
  const [byFicheRes, bySkuRes] = await Promise.all([
    bcFicheIds.length
      ? supabase.from('lab_order_lines').select(lineCols).in('fiche_id', bcFicheIds).gte('delivery_date', today)
      : Promise.resolve({ data: [] as any[] }),
    bcSkus.length
      ? supabase.from('lab_order_lines').select(lineCols).in('product_sku', bcSkus).gte('delivery_date', today)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const byId = new Map<string, any>();
  for (const l of [...(byFicheRes.data ?? []), ...(bySkuRes.data ?? [])]) byId.set(l.id, l);
  const lines = Array.from(byId.values())
    .sort((a, b) => (a.delivery_date + (a.delivery_time ?? '')).localeCompare(b.delivery_date + (b.delivery_time ?? '')));

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
