import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import Sidebar from '@/components/Sidebar';
import SectionTabs from '@/components/SectionTabs';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role, can_purchase')
    .eq('id', session.user.id)
    .single();

  // Shop accounts (shared login per shop, 2026-08-19) never see the admin dashboard/Sidebar —
  // same treatment as chef/worker below, redirected to their own space before anything else.
  if (profile?.role === 'shop') redirect('/shop');

  // Online-sales account (2026-09-06) — same treatment: her own space, never the admin app.
  if (profile?.role === 'online_sales') redirect('/online-orders');

  // Shop manager (2026-09-10) — individual login, own space (multi-shop cockpit), never the
  // admin app either.
  if (profile?.role === 'shop_manager') redirect('/shop-manager');

  // Only lab roles can access the app — catalogue-only users get bounced to login
  const LAB_ROLES = ['admin', 'lab_manager', 'assistant', 'chef', 'worker', 'purchasing'];
  if (!profile || !LAB_ROLES.includes(profile.role)) redirect('/login');

  // Purchasing (Axel, 2026-10-08): storage manager + purchasing assistant — their own pages
  // (/purchasing) and the OEM orders screen, nothing else of the admin app.
  const purchasingPath = headers().get('x-pathname') ?? '';
  if (profile.role === 'purchasing' && !purchasingPath.startsWith('/purchasing') && !purchasingPath.startsWith('/oem-orders')) redirect('/purchasing');

  // Chefs and workers go to their station — they don't use the full admin layout.
  // Exception: chefs may open the fiche editor (recipe-only mode, gated again in the page + RLS).
  const pathname = headers().get('x-pathname') ?? '';
  const chefAllowed = profile.role === 'chef' && pathname.startsWith('/admin/fiches/');
  if ((profile.role === 'chef' || profile.role === 'worker') && !chefAllowed) redirect('/station/me');

  const { loadRawCounts, badgesForRole } = await import('@/lib/nav-badges');
  const badges = badgesForRole(await loadRawCounts(), profile as any);
  const { badgeOf } = await import('@/lib/nav');
  // Control board badge = everything still open for this role (sum of the menu badges).
  badges.today = (['delivery', 'special', 'reception', 'oem', 'purchasing', 'check'] as const)
    .reduce((t, k) => t + badgeOf(badges, k), 0);

  return (
    <div className="flex min-h-screen bg-cream">
      <Sidebar profile={profile} badges={badges} />
      <main className="flex-1 min-w-0 lg:ml-64 pt-12 lg:pt-0 pb-[calc(64px+env(safe-area-inset-bottom,0px))] lg:pb-0">
        <SectionTabs profile={profile} badges={badges} />
        <div className="max-w-6xl mx-auto px-3 py-4 sm:px-4 sm:py-6">{children}</div>
      </main>
    </div>
  );
}
