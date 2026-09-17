import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ConsommationMPView from './ConsommationMPView';

// Admin uniquement (pas lab_manager), sur demande explicite d'Axel (2026-09-17) — même posture
// que /analytics et /admin/reconciliation.
export const revalidate = 0;

export default async function ConsommationMPPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  return <ConsommationMPView />;
}
