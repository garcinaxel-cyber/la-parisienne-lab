import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import PhotoImportView from './PhotoImportView';

export const dynamic = 'force-dynamic';
// Each click copies a small batch of files inside Supabase Storage; a batch takes a few seconds.
export const maxDuration = 60;

// Admin-only, one-time tool (Axel, 2026-10-07): copy the website's product photos into the lab
// app's own bucket so the recipe cards stop pointing at the website's files. Nothing here runs
// on its own: the import only happens when an admin presses the button.
export default async function PhotoImportPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  return <PhotoImportView />;
}
