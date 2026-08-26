import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect, notFound } from 'next/navigation';
import { ensureDeliveryOrderChecklist } from '@/lib/delivery-check';
import DeliveryCheckOrderView from './DeliveryCheckOrderView';

export const revalidate = 0;

// Lab-local (Asia/Ho_Chi_Minh) "today" — used only to know whether this order's own date is
// the "Aujourd'hui" or "Demain" tab, so the Retour link can send the assistant back to the
// correct tab instead of always resetting to today (2026-08-10).
function labToday(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

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
  const today = labToday();
  // A past date (2026-08-26: late-created orders for a manual cake from a prior day) belongs on
  // the "late" tab, not "tomorrow" — the old ternary only ever considered today vs. everything else.
  const backHref = date === today ? '/delivery-check' : date > today ? '/delivery-check?day=tomorrow' : '/delivery-check?day=late';

  return <DeliveryCheckOrderView header={header} lines={lines} backHref={backHref} />;
}
