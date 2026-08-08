import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ImportView from './ImportView';

export const revalidate = 0;

// Admin-only per Axel (2026-08-08) — was reachable by any lab role (no check existed here at
// all, only the broad (app)/layout.tsx LAB_ROLES gate); restricted to declutter lab_manager/
// assistant's sidebar, tightened here to match the hidden nav link.
export default async function ImportPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  return <ImportView />;
}
