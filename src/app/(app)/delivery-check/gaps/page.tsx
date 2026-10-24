import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { listDeliveryGaps } from '@/lib/reception-gaps';
import { receptionOdooMode } from '@/lib/reception-odoo';
import GapsView from './GapsView';
import OffslipPanel from './OffslipPanel';
import StuckInPanel from './StuckInPanel';
import TasksPanel from './TasksPanel';
import { loadProductionTasks } from '@/lib/delivery-tasks';

export const revalidate = 0;

export default async function DeliveryGapsPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const [{ gaps, schemaReady }, prod] = await Promise.all([listDeliveryGaps(sb as any), loadProductionTasks(sb as any)]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const { count: offslipOpen } = await sb.from('lab_offslip_items').select('id', { count: 'exact', head: true }).eq('status', 'open');
  const waitingShop = gaps.filter(g => g.status === 'waiting_shop').length;
  const damagedNotBack = gaps.filter(g => (g.kind === 'damaged' || g.labCause === 'damaged_returned') && g.labCause !== 'shop_miscount' && g.status !== 'waiting_shop' && !g.returnConfirmedAt).length;
  return <div className="space-y-2">
    <div className="px-4 pt-4 lg:px-8"><TasksPanel open={prod.open} resolved={prod.resolved} recounts={prod.recounts}
      receptionOpen={gaps.filter(g => g.kind !== 'damaged' && g.status === 'open').length + (offslipOpen ?? 0)} waitingShop={waitingShop} damagedNotBack={damagedNotBack} today={today} /></div>
    <GapsView initialGaps={gaps} schemaReady={schemaReady} odooMode={receptionOdooMode()} canSendOdoo={['admin', 'lab_manager'].includes(profile?.role ?? '')} extra={<><StuckInPanel /><OffslipPanel mode="open" /></>} extraClosed={<OffslipPanel mode="closed" />} />
  </div>;
}
