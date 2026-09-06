import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import OnlineOrdersView from './OnlineOrdersView';

export const dynamic = 'force-dynamic';

// Online-sales home (Axel, 2026-09-06) — own top-level route (sibling to /shop), never under
// (app) so this role never sees the admin Sidebar. Admin may also open this page directly and
// sees every seller's orders (server actions in ./actions.ts branch on role, not on this gate).
export default async function OnlineOrdersPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single();
  if (!profile || !['online_sales', 'admin'].includes(profile.role)) redirect('/dashboard');

  return <OnlineOrdersView fullName={profile.full_name ?? ''} isAdmin={profile.role === 'admin'} />;
}
