import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import ShopManagersAdminView from './ShopManagersAdminView';

export const dynamic = 'force-dynamic';

export default async function ShopManagersAdminPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  return <ShopManagersAdminView />;
}
