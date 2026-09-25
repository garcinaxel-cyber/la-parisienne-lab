import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import OemOrdersPageView from './OemOrdersPageView';

export const revalidate = 0;
// Packaging entries create + validate Odoo MOs inside the server action (several RPCs each).
export const maxDuration = 120;

// OEM Orders tracker — office side (admin / lab_manager / assistant). Axel, 2026-09-25.
export default async function OemOrdersPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  const role = profile?.role ?? '';
  if (!['admin', 'lab_manager', 'assistant'].includes(role)) redirect('/dashboard');

  return <OemOrdersPageView role={role} userId={session.user.id} userName={profile?.full_name ?? null} />;
}
