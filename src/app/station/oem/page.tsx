import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import StationOemView from './StationOemView';

export const revalidate = 0;
// Packaging entries create + validate Odoo MOs inside the server action (several RPCs each).
export const maxDuration = 120;

// OEM Orders tracker — station side (Team Hung). Same view as the office page (Axel: "onglet hung
// et assistante doivent pouvoir voir la même chose"); corrections stay with admin/lab_manager.
export default async function StationOemPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  const role = profile?.role ?? '';
  if (!['admin', 'lab_manager', 'assistant', 'chef', 'worker'].includes(role)) redirect('/login');

  return <StationOemView role={role} userId={session.user.id} userName={profile?.full_name ?? null} />;
}
