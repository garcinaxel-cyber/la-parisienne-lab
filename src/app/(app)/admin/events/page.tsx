import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import EventsAdminView from './EventsAdminView';

export const dynamic = 'force-dynamic';

// Admin-only (Axel, 2026-09-12): create/close temporary "event" shops. Axel configures the Odoo
// warehouse himself (Kho vận → Cấu hình → Kho hàng) — this page only links to it by code, it
// never creates or writes to stock.warehouse. Same admin guard as every other /admin/* page.
export default async function EventsAdminPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  // Lab manager allowed in since 2026-10-07 (list + one-click entry); only an admin creates,
  // closes or sets the QR of an event — enforced again server-side in every action.
  if (profile?.role !== 'admin' && profile?.role !== 'lab_manager') redirect('/dashboard');

  return <EventsAdminView canManage={profile.role === 'admin'} />;
}
