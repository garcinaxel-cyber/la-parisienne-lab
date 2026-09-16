import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import Sidebar from '@/components/Sidebar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
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
  const LAB_ROLES = ['admin', 'lab_manager', 'assistant', 'chef', 'worker'];
  if (!profile || !LAB_ROLES.includes(profile.role)) redirect('/login');

  // Chefs and workers go to their station — they don't use the full admin layout.
  // Exception: chefs may open the fiche editor (recipe-only mode, gated again in the page + RLS).
  const pathname = headers().get('x-pathname') ?? '';
  const chefAllowed = profile.role === 'chef' && pathname.startsWith('/admin/fiches/');
  if ((profile.role === 'chef' || profile.role === 'worker') && !chefAllowed) redirect('/station/me');

  // Badges: transfer notes awaiting reception (both reception sub-tabs — internal AND
  // Shop ↔ Lab, Axel 2026-09-16: "l onglet qui averti du nombre de reception a check doit
  // prendre en compte le deuxieme sous onglet") + manual orders still to enter in Odoo.
  // Shop ↔ Lab counts mirror ShopLabReceptionTab's own "from today" (Vietnam calendar day)
  // cutoff — same vnTodayStartIso() logic as shop/actions.ts, duplicated here since that file
  // is 'use server' (exports must be async actions, not a plain helper to import).
  function vnTodayStartIso(): string {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
    return new Date(`${fmt.format(new Date())}T00:00:00+07:00`).toISOString();
  }
  const todayVNIso = vnTodayStartIso();
  const [
    { count: pendingInternalTransfers },
    { count: pendingShopLabTransfers },
    { count: pendingShopLabLosses },
    { count: pendingExceptional },
  ] = await Promise.all([
    supabase.from('lab_stock_transfers').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('lab_shop_transfers').select('*', { count: 'exact', head: true }).eq('to_shop', 'Lab').eq('status', 'sent').gte('sent_at', todayVNIso),
    supabase.from('lab_shop_losses').select('*', { count: 'exact', head: true }).is('lab_received_at', null).gte('reported_at', todayVNIso),
    supabase.from('lab_manual_cakes').select('*', { count: 'exact', head: true }).eq('needs_odoo', true).is('matched_order_ref', null),
  ]);
  const pendingTransfers = (pendingInternalTransfers ?? 0) + (pendingShopLabTransfers ?? 0) + (pendingShopLabLosses ?? 0);

  // Check badge: admin-only table (RLS), so only fetched for admins. Sums all 4 checks
  // (2026-08-20) — issue_count alone used to mean "reconciliation only".
  let reconciliationIssues = 0;
  if (profile.role === 'admin') {
    const { data: lastRun } = await supabase
      .from('lab_reconciliation_runs')
      .select('issue_count, delivery_coverage_count, production_stock_count, stock_odoo_count')
      .order('run_at', { ascending: false }).limit(1).maybeSingle();
    reconciliationIssues = (lastRun?.issue_count ?? 0) + (lastRun?.delivery_coverage_count ?? 0)
      + (lastRun?.production_stock_count ?? 0) + (lastRun?.stock_odoo_count ?? 0);
  }

  return (
    <div className="flex min-h-screen bg-cream">
      <Sidebar profile={profile} pendingTransfers={pendingTransfers ?? 0} pendingExceptional={pendingExceptional ?? 0} reconciliationIssues={reconciliationIssues} />
      <main className="flex-1 overflow-auto lg:ml-64 pt-[88px] lg:pt-0">
        <div className="max-w-6xl mx-auto px-3 py-4 sm:px-4 sm:py-8">{children}</div>
      </main>
    </div>
  );
}
