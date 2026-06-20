import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import UsersView from './UsersView';

export const revalidate = 0;

export default async function UsersPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  // Only show lab users — catalogue users (admin/sales/viewer) stay invisible here
  const { data: users } = await supabase
    .from('profiles')
    .select(`
      id, full_name, role,
      lab_profiles(team)
    `)
    .in('role', ['lab_manager', 'assistant', 'chef'])
    .order('full_name');

  // Supabase returns one-to-one joins as arrays; normalise to single object
  const normalised = (users ?? []).map((u: any) => ({
    ...u,
    lab_profiles: Array.isArray(u.lab_profiles) ? (u.lab_profiles[0] ?? null) : u.lab_profiles,
  }));

  return <UsersView users={normalised} />;
}
