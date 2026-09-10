import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';
import { computeShopRecaps } from '@/lib/shop-recap';
import ShopProcessView from './ShopProcessView';

export const revalidate = 0;

// Admin-only recap of the SHOPS' own process compliance for one day (today or yesterday only —
// Axel, 2026-09-08: "tu met max la veille et le jour meme en historique", storage-conscious:
// this reads live from the operational tables at render time, no new table, no history kept
// beyond what those tables already retain on their own). Explicitly the shops' point of view —
// NOT Lab-internal processes (those live in Check, /admin/reconciliation).
//
// The actual computation (5 columns: réception, comptage, commande, pertes, transferts) lives in
// src/lib/shop-recap.ts (extracted 2026-09-10) so the shop-manager feature's own "Today"/"Shops"
// tabs can reuse the exact same batched queries scoped to one manager's shops, instead of a
// second hand-copied version drifting out of sync with this one.
function vnDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const SHOPS = PORTAL_SHOP_NAMES; // Moon Flower + the 4 La Paris shops with a portal login

export default async function ShopProcessPage({ searchParams }: { searchParams: { date?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  const which: 'today' | 'yesterday' = searchParams?.date === 'yesterday' ? 'yesterday' : 'today';
  const now = new Date();
  const date = vnDateStr(which === 'yesterday' ? new Date(now.getTime() - 86400000) : now);

  // lab_shop_stock_sessions_done and lab_shop_transfers have RLS enabled with no policy at
  // all (only ever written/read via server actions using the service-role key elsewhere in
  // the app — see shop/actions.ts, api/odoo/stock-count-recap) -- the cookie-scoped client
  // above would silently see zero rows there. Service-role client for the actual data reads;
  // the admin check above already gates who can reach this page.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) redirect('/dashboard');
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const recaps = await computeShopRecaps(svc, SHOPS, date);

  return <ShopProcessView date={date} which={which} recaps={recaps} />;
}
