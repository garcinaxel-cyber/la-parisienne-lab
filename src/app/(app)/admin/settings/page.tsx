import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import SettingsView from './SettingsView';

export const revalidate = 0;

export default async function SettingsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { data: settings } = await supabase
    .from('lab_notification_settings')
    .select('target, zalo_webhook_url')
    .order('target');

  return <SettingsView settings={settings ?? []} />;
}
