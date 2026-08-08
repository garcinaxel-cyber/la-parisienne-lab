import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect, notFound } from 'next/navigation';
import { ensureDeliveryOrderChecklist } from '@/lib/delivery-check';
import DeliveryCheckOrderView from './DeliveryCheckOrderView';

export const revalidate = 0;

// order_ref can contain literal slashes (Odoo replenishment refs: "REP/2026/00985") —
// a catch-all segment captures them as an array; a single [orderRef] segment would not.
export default async function DeliveryCheckOrderPage({ params }: { params: { date: string; orderRef: string[] } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const date = params.date;
  const orderRef = (params.orderRef ?? []).join('/');
  if (!date || !orderRef) notFound();

  const { header, lines } = await ensureDeliveryOrderChecklist(supabase, date, orderRef);

  return <DeliveryCheckOrderView header={header} lines={lines} />;
}
