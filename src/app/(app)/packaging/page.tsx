import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { PACKAGING_ROLES } from '@/lib/raw-materials';
import PackagingView from './PackagingView';

// Packaging purchase requests (Axel, 2026-11-10): the assistants and lab managers order packaging from
// purchasing (Ms Flavor) on the chefs' request screen, packaging only. Chefs never reach this page.
export const dynamic = 'force-dynamic';

export default async function PackagingPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!(PACKAGING_ROLES as readonly string[]).includes(profile?.role ?? '')) redirect('/dashboard');
  return <PackagingView userName={(profile?.full_name as string) || null} />;
}
