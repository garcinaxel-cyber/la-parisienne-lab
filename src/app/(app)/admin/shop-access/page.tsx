import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ShopAccessView from './ShopAccessView';

export const dynamic = 'force-dynamic';

// Exactly 5 shops get a portal account — matches SHOP_ODOO_MAP's keys (odoo-shop-order-sync.ts)
// minus "Lab" itself, and Axel's explicit list, 2026-08-19. Not derived from delivery history:
// a shop showing up once in an old order (Winmart, HAPPY TRUE MARKET, etc.) should NOT get a
// login — only these named partner shops.
export const SHOP_NAMES = ['Moon Flower', 'La Paris Bà Triệu', 'La Paris Long Biên', 'La Paris Tây Hồ', 'La Paris Timecity'];

export default async function ShopAccessPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { data: shopProfiles } = await supabase
    .from('lab_profiles').select('id, shop_name').in('shop_name', SHOP_NAMES);
  const idByShop: Record<string, string> = {};
  for (const p of shopProfiles ?? []) if (p.shop_name) idByShop[p.shop_name] = p.id;

  // Email lives on auth.users, not profiles — resolve it via the service-role admin API for
  // the (at most 5) shops that already have an account. Cheap and simple at this scale.
  let emailById: Record<string, string> = {};
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && Object.keys(idByShop).length) {
    const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const results = await Promise.all(Object.values(idByShop).map(id => admin.auth.admin.getUserById(id)));
    results.forEach((r, i) => { const id = Object.values(idByShop)[i]; if (r.data?.user?.email) emailById[id] = r.data.user.email; });
  }

  const shops = SHOP_NAMES.map(name => {
    const id = idByShop[name];
    return { name, hasAccount: !!id, email: id ? emailById[id] ?? null : null };
  });

  return <ShopAccessView shops={shops} />;
}
