import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import Sidebar from '@/components/Sidebar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', session.user.id)
    .single();

  // Only lab roles can access the app — catalogue-only users get bounced to login
  const LAB_ROLES = ['admin', 'lab_manager', 'assistant', 'chef'];
  if (!profile || !LAB_ROLES.includes(profile.role)) redirect('/login');

  // Chefs get redirected to their station view — they don't use the app layout
  if (profile.role === 'chef') redirect('/station/me');

  return (
    <div className="flex min-h-screen bg-cream">
      <Sidebar profile={profile} />
      <main className="flex-1 overflow-auto lg:ml-64">
        <div className="max-w-6xl mx-auto px-4 py-8">{children}</div>
      </main>
    </div>
  );
}
