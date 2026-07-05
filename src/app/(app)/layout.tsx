import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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
  const LAB_ROLES = ['admin', 'lab_manager', 'assistant', 'chef', 'worker'];
  if (!profile || !LAB_ROLES.includes(profile.role)) redirect('/login');

  // Chefs and workers go to their station — they don't use the full admin layout.
  // Exception: chefs may open the fiche editor (recipe-only mode, gated again in the page + RLS).
  const pathname = headers().get('x-pathname') ?? '';
  const chefAllowed = profile.role === 'chef' && pathname.startsWith('/admin/fiches/');
  if ((profile.role === 'chef' || profile.role === 'worker') && !chefAllowed) redirect('/station/me');

  return (
    <div className="flex min-h-screen bg-cream">
      <Sidebar profile={profile} />
      <main className="flex-1 overflow-auto lg:ml-64">
        <div className="max-w-6xl mx-auto px-4 py-8">{children}</div>
      </main>
    </div>
  );
}
