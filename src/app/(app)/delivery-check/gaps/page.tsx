import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { listDeliveryGaps } from '@/lib/reception-gaps';
import { receptionOdooMode } from '@/lib/reception-odoo';
import GapsView from './GapsView';
import OffslipPanel from './OffslipPanel';
import StuckInPanel from './StuckInPanel';

export const revalidate = 0;

export default async function DeliveryGapsPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { gaps, schemaReady } = await listDeliveryGaps(sb as any);
  return <GapsView initialGaps={gaps} schemaReady={schemaReady} odooMode={receptionOdooMode()} canSendOdoo={['admin', 'lab_manager'].includes(profile?.role ?? '')} extra={<><StuckInPanel /><OffslipPanel mode="open" /></>} extraClosed={<OffslipPanel mode="closed" />} />;
}
