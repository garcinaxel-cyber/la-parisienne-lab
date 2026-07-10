import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import UsersView from './UsersView';

export const revalidate = 0;

export default async function UsersPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  // All lab-role users (admin included — catalogue roles stay invisible)
  const { data: users } = await supabase
    .from('profiles')
    .select(`
      id, full_name, role,
      lab_profiles(team)
    `)
    .in('role', ['admin', 'lab_manager', 'assistant', 'chef', 'worker'])
    .order('full_name');

  // Supabase returns one-to-one joins as arrays; normalise to single object
  const normalised = (users ?? []).map((u: any) => ({
    ...u,
    lab_profiles: Array.isArray(u.lab_profiles) ? (u.lab_profiles[0] ?? null) : u.lab_profiles,
  }));

  // Sort by role hierarchy, then team, then name — not by arrival
  const ROLE_ORDER: Record<string, number> = { admin: 0, lab_manager: 1, assistant: 2, chef: 3, worker: 4 };
  normalised.sort((a: any, b: any) => {
    const ra = ROLE_ORDER[a.role] ?? 9, rb = ROLE_ORDER[b.role] ?? 9;
    if (ra !== rb) return ra - rb;
    const ta = a.lab_profiles?.team ?? '', tb = b.lab_profiles?.team ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    return (a.full_name ?? '').localeCompare(b.full_name ?? '');
  });

  return <UsersView users={normalised} />;
}
