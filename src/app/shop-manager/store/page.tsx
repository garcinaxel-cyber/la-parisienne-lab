import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';
import ShopView from '@/app/shop/ShopView';

export const dynamic = 'force-dynamic';

// A shop_manager's "Store interface" AND "Order" quick actions both land here — the exact same
// real ShopView a shop's own shared login uses (Axel, 2026-08-25 precedent: "je veux exactement
// comme les QR code des chefs"), just opened with an explicit ?shop= and, for the Order quick
// action, ?tab=order so it opens straight on the cart instead of Deliveries. Zero new UI for
// this: reuses shop/actions.ts's requireShopOrStaffSession, extended 2026-09-10 to also accept a
// shop_manager session scoped to one of THEIR OWN shops (re-checked here too, defense in depth).
type SearchParams = { shop?: string; tab?: string };
const VALID_TABS = ['deliveries', 'cakes', 'losses', 'stock', 'report', 'order', 'transfer'] as const;

export default async function ShopManagerStorePage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop_manager') redirect('/dashboard');

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) redirect('/shop-manager');
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: manager } = await svc.from('lab_shop_managers')
    .select('shops').eq('user_id', session.user.id).eq('active', true).maybeSingle();
  const shopName = searchParams?.shop ?? '';
  if (!manager || !PORTAL_SHOP_NAMES.includes(shopName) || !(manager.shops ?? []).includes(shopName)) redirect('/shop-manager');

  const initialTab = (VALID_TABS as readonly string[]).includes(searchParams?.tab ?? '') ? (searchParams!.tab as typeof VALID_TABS[number]) : 'deliveries';

  return <ShopView shopName={shopName} readOnly initialTab={initialTab} viewerRole="manager" />;
}
