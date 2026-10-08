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
  // 'purchasing' sees it read-only (Axel, 2026-10-08) — write actions stay gated in oem-actions.ts.
  if (!['admin', 'lab_manager', 'assistant', 'purchasing'].includes(role)) redirect('/dashboard');

  return <OemOrdersPageView role={role} userId={session.user.id} userName={profile?.full_name ?? null} />;
}
