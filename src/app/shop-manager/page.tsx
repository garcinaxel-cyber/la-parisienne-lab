import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';
import ShopManagerView from './ShopManagerView';

export const dynamic = 'force-dynamic';

// Shop Manager home (Axel, 2026-09-10) — own top-level route (sibling to /shop, /online-orders),
// never under (app), so this role never sees the admin Sidebar/dashboard. An individual login
// (role='shop_manager') linked to an existing lab_shop_managers row via user_id — the SAME row
// used for the shared-shop-login PIN unlock (src/app/shop/actions.ts's resolveManager), now also
// reachable on its own. Managers here cover ALL 5 portal shops (Axel: "ils ont accès à toutes les
// boutiques"), so this page is a multi-shop cockpit, not a single-shop portal like /shop.
export default async function ShopManagerHomePage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop_manager') redirect('/dashboard');

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) redirect('/login');
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: manager } = await svc.from('lab_shop_managers')
    .select('name, color, shops').eq('user_id', session.user.id).eq('active', true).maybeSingle();

  if (!manager) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: '#FFF4CC' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: '1px solid #E0D49A' }}>
          <div className="text-3xl mb-2">⚠️</div>
          <h1 className="font-bold text-lg" style={{ color: '#1A4731' }}>Tài khoản chưa được thiết lập</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>Liên hệ Lab để hoàn tất cấu hình.</p>
        </div>
      </div>
    );
  }

  // Keep PORTAL_SHOP_NAMES order (Moon Flower first, then the 4 La Paris shops) so the shop
  // switcher / Shops tab is always in the same, predictable order regardless of how `shops` was
  // written on the manager row.
  const shops = PORTAL_SHOP_NAMES.filter(s => (manager.shops ?? []).includes(s));

  return <ShopManagerView managerName={manager.name} color={manager.color} shops={shops} />;
}
