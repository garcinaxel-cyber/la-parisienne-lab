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

  // Only lab roles can access the app — catalogue-only users get bounced to login
  const LAB_ROLES = ['admin', 'lab_manager', 'assistant', 'chef', 'worker'];
  if (!profile || !LAB_ROLES.includes(profile.role)) redirect('/login');

  // Chefs and workers go to their station — they don't use the full admin layout.
  // Exception: chefs may open the fiche editor (recipe-only mode, gated again in the page + RLS).
  const pathname = headers().get('x-pathname') ?? '';
  const chefAllowed = profile.role === 'chef' && pathname.startsWith('/admin/fiches/');
  if ((profile.role === 'chef' || profile.role === 'worker') && !chefAllowed) redirect('/station/me');

  // Badges: transfer notes awaiting reception + manual orders still to enter in Odoo
  const [{ count: pendingTransfers }, { count: pendingExceptional }] = await Promise.all([
    supabase.from('lab_stock_transfers').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('lab_manual_cakes').select('*', { count: 'exact', head: true }).eq('needs_odoo', true).is('matched_order_ref', null),
  ]);

  // Reconciliation badge: admin-only table (RLS), so only fetched for admins.
  let reconciliationIssues = 0;
  if (profile.role === 'admin') {
    const { data: lastRun } = await supabase
      .from('lab_reconciliation_runs').select('issue_count').order('run_at', { ascending: false }).limit(1).maybeSingle();
    reconciliationIssues = lastRun?.issue_count ?? 0;
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
