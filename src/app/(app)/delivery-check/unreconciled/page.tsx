import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { ensureUnreconciledChecklist } from '@/lib/delivery-check';
import DeliveryCheckUnreconciledView from './DeliveryCheckUnreconciledView';

export const revalidate = 0;

function labTodayTomorrow(): [string, string] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const tomorrow = fmt.format(new Date(now.getTime() + 24 * 3600 * 1000));
  return [today, tomorrow];
}

export default async function DeliveryCheckUnreconciledPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [today, tomorrow] = labTodayTomorrow();
  const lines = await ensureUnreconciledChecklist(supabase, [today, tomorrow]);

  return <DeliveryCheckUnreconciledView lines={lines} />;
}
