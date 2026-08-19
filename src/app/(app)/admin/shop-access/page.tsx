import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ShopAccessView from './ShopAccessView';

export const dynamic = 'force-dynamic';

export default async function ShopAccessPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  // Canonical shop list = every distinct shop_name seen recently across deliveries + manual
  // cakes — shop_name is free text everywhere else in this app (no separate "shops" master
  // table), so this mirrors that existing convention rather than introducing a new one.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [{ data: fromOrders }, { data: fromCakes }, { data: links }] = await Promise.all([
    supabase.from('lab_delivery_orders').select('shop_name').not('shop_name', 'is', null).gte('delivery_date', since).limit(3000),
    supabase.from('lab_manual_cakes').select('shop_name').not('shop_name', 'is', null).gte('delivery_date', since).limit(3000),
    supabase.from('lab_shop_portal_links').select('id, shop_name, token, active, created_at, regenerated_at'),
  ]);

  const shopSet = new Set<string>();
  for (const r of fromOrders ?? []) if (r.shop_name) shopSet.add(r.shop_name);
  for (const r of fromCakes ?? []) if (r.shop_name) shopSet.add(r.shop_name);
  for (const l of links ?? []) shopSet.add(l.shop_name); // keep shops with a link even if no recent activity

  const linkByShop: Record<string, { id: string; token: string; active: boolean; created_at: string; regenerated_at: string | null }> = {};
  for (const l of links ?? []) linkByShop[l.shop_name] = l;

  const shops = Array.from(shopSet).sort((a, b) => a.localeCompare(b)).map(name => ({
    name, link: linkByShop[name] ?? null,
  }));

  return <ShopAccessView shops={shops} />;
}
