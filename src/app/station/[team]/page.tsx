import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import StationView from './StationView';
import type { Team } from '@/lib/types';
import { TEAMS } from '@/lib/types';

export const revalidate = 0;

export default async function StationPage({ params, searchParams }: { params: { team: string }; searchParams?: { date?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  let team = params.team as Team;

  if (params.team === 'me') {
    if (!session) redirect('/login');
    const { data: labProfile } = await supabase
      .from('lab_profiles')
      .select('team')
      .eq('id', session.user.id)
      .single();
    if (!labProfile?.team) redirect('/login');
    team = labProfile.team as Team;
  }

  if (!TEAMS.includes(team)) redirect('/login');

  const today = new Date().toISOString().split('T')[0];
  const viewDate = searchParams?.date ?? today;
  const isHistoryView = viewDate !== today;

  const { data: assignments } = await supabase
    .from('lab_assignments')
    .select(`
      id, product_id, product_name_vi, product_name_en, image_url,
      variant_label, total_qty, qty_to_produce, qty_produced,
      status, is_extra, notes, sort_order, import_id,
      lab_imports!inner(delivery_date, order_number, type, status),
      products!product_id(sku)
    `)
    .eq('team', team)
    .eq('lab_imports.status', 'published')
    .eq('lab_imports.delivery_date', viewDate)
    .order('sort_order')
    .limit(120);

  const assignmentIds = (assignments ?? []).map((a: any) => a.id);

  // Breakdowns
  const { data: breakdowns } = assignmentIds.length > 0
    ? await supabase.from('lab_assignments').select('id, breakdown').in('id', assignmentIds)
    : { data: [] as any[] };

  const breakdownMap: Record<string, any[]> = {};
  for (const b of breakdowns ?? []) {
    breakdownMap[b.id] = Array.isArray(b.breakdown) ? b.breakdown : [];
  }

  // Weight from fiche meta
  const productIds = (assignments ?? [])
    .map((a: any) => a.product_id)
    .filter(Boolean) as string[];

  const { data: ficheMeta } = productIds.length > 0
    ? await supabase
        .from('lab_fiche_meta')
        .select('product_id, weight_grams')
        .in('product_id', productIds)
    : { data: [] as any[] };

  const weightMap: Record<string, number | null> = {};
  for (const m of ficheMeta ?? []) {
    weightMap[m.product_id] = m.weight_grams ?? null;
  }

  // Categories for products
  const { data: productCats } = productIds.length > 0
    ? await supabase
        .from('products')
        .select('id, categories!category_id(name_vi, name_en)')
        .in('id', productIds)
    : { data: [] as any[] };

  const categoryNameMap: Record<string, { vi: string; en: string }> = {};
  for (const p of productCats ?? []) {
    const cat = Array.isArray(p.categories) ? p.categories[0] : p.categories;
    if (cat && p.id) categoryNameMap[p.id] = { vi: cat.name_vi ?? '', en: cat.name_en ?? '' };
  }

  // Delivery times from lab_order_lines (per order_ref)
  const importIds = Array.from(new Set((assignments ?? []).map((a: any) => a.import_id).filter(Boolean))) as string[];
  const { data: orderLineDeliveries } = importIds.length > 0
    ? await supabase
        .from('lab_order_lines')
        .select('order_ref, delivery_time')
        .in('import_id', importIds)
        .not('delivery_time', 'is', null)
        .not('order_ref', 'is', null)
    : { data: [] as any[] };

  const deliveryTimeByRef: Record<string, string> = {};
  for (const ol of orderLineDeliveries ?? []) {
    if (ol.order_ref && ol.delivery_time) deliveryTimeByRef[ol.order_ref] = ol.delivery_time;
  }

  const normalised = (assignments ?? []).map((a: any) => ({
    ...a,
    sku: a.products?.sku ?? null,
    weight_grams: a.product_id ? (weightMap[a.product_id] ?? null) : null,
    category_name_vi: a.product_id ? (categoryNameMap[a.product_id]?.vi ?? null) : null,
    category_name_en: a.product_id ? (categoryNameMap[a.product_id]?.en ?? null) : null,
    breakdown: (breakdownMap[a.id] ?? []).map((b: any) => ({
      ...b,
      delivery_time: b.order_ref ? (deliveryTimeByRef[b.order_ref] ?? null) : null,
    })),
    lab_imports: Array.isArray(a.lab_imports) ? a.lab_imports[0] : a.lab_imports,
    products: undefined,
  }));

  return <StationView key={viewDate} team={team} teamSlug={params.team} assignments={normalised} viewDate={viewDate} today={today} isHistoryView={isHistoryView} />;
}
