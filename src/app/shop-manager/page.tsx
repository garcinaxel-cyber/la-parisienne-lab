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
//
// Admin one-click preview (Axel, 2026-09-21 — "comme les QR codes des chefs, accéder à leur
// interface facilement en un clic"): admin is let through this same gate too, same posture as
// /station/[team] already has for the chef stations. Admin has no lab_shop_managers row of their
// own to look up, but that's fine — every manager covers the exact same 5 portal shops anyway
// (see ShopManagersAdminView / the comment above), so there's nothing manager-specific to pick;
// a synthetic "Admin" identity with the full shop list shows the identical cockpit. The route's
// own action file (actions.ts) only exposes two reads (Today / Shops recap) — no write action
// lives here, writes go through shop/actions.ts's requireShopOrStaffSession, which already
// allows admin unrestricted access regardless of this page.
export default async function ShopManagerHomePage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop_manager' && profile?.role !== 'admin') redirect('/dashboard');

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) redirect('/login');
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const manager = profile.role === 'admin'
    ? { name: 'Admin', color: '#1f2937', shops: [...PORTAL_SHOP_NAMES] }
    : (await svc.from('lab_shop_managers')
        .select('name, color, shops').eq('user_id', session.user.id).eq('active', true).maybeSingle()).data;

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
