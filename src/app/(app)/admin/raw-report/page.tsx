import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import RawReportView from './RawReportView';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // the report reads the Odoo recipes (several batched calls)

export default async function RawReportPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');
  return <RawReportView />;
}
