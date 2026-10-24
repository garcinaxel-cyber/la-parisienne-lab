import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { listDeliveryGaps } from '@/lib/reception-gaps';
import { receptionOdooMode } from '@/lib/reception-odoo';
import GapsView from './GapsView';
import OffslipPanel from './OffslipPanel';
import StuckInPanel from './StuckInPanel';
import TasksPanel from './TasksPanel';
import { loadProductionTasks, loadMadeWithoutOrder, loadShopsNotConfirmed } from '@/lib/delivery-tasks';

export const revalidate = 0;

export default async function DeliveryGapsPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const [{ gaps, schemaReady }, prod, lo, notConfirmed] = await Promise.all([listDeliveryGaps(sb as any), loadProductionTasks(sb as any), loadMadeWithoutOrder(sb as any), loadShopsNotConfirmed(sb as any).catch(() => [])]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const { count: offslipOpen } = await sb.from('lab_offslip_items').select('id', { count: 'exact', head: true }).eq('status', 'open');
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  // Damaged not back: last 7 days only (Axel, 2026-10-24).
  const damagedList = gaps.filter(g => (g.kind === 'damaged' || g.labCause === 'damaged_returned') && g.labCause !== 'shop_miscount' && g.status !== 'waiting_shop' && !g.returnConfirmedAt && g.deliveryDate >= since7);
  const dmgByShop: Record<string, number> = {};
  for (const g of damagedList) dmgByShop[g.shopName] = (dmgByShop[g.shopName] ?? 0) + 1;
  const damaged = { shops: Object.keys(dmgByShop).length, items: damagedList.length, byShop: Object.entries(dmgByShop).map(([shop, n]) => ({ shop, n })) };
  // Settled gaps the Lab manager / admin still has to send to Odoo (final validation), one per order.
  const sendMap: Record<string, { key: string; orderRef: string; shop: string; lines: number }> = {};
  for (const g of gaps.filter(g => g.status === 'closed' && g.odooMode !== 'sent' && g.labCause !== 'shop_miscount' && !(g.kind === 'extra' && g.labCause !== 'lab_sent_extra'))) {
    const e = (sendMap[g.deliveryOrderId] ??= { key: g.key, orderRef: g.orderRef, shop: g.shopName, lines: 0 }); e.lines++;
  }
  const toSend = Object.values(sendMap);
  const receptionDoneToday = gaps.filter(g => g.status === 'closed' && g.decidedAt && new Date(g.decidedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) === today)
    .map(g => `${g.orderRef} · ${g.shopName} · ${g.product} · ${g.kind === 'extra' ? '+' : '−'}${g.qty} · ${g.labCause ?? ''}${g.decidedBy ? ` · ${g.decidedBy}` : ''}`);
  const reception = gaps.filter(g => g.kind !== 'damaged' && g.status === 'open')
    .sort((a, b) => (a.deadlineAt ?? '9').localeCompare(b.deadlineAt ?? '9'))
    .map(g => ({ key: g.key, product: g.product, shop: g.shopName, orderRef: g.orderRef, deliveryDate: g.deliveryDate, kind: g.kind, qty: g.qty, sent: g.sent, received: g.received, deadlineAt: g.deadlineAt }));
  return <GapsView top={<TasksPanel leftovers={lo.open} leftoverDone={lo.done} open={prod.open} resolved={prod.resolved} recounts={prod.recounts}
      reception={reception} offslipOpen={offslipOpen ?? 0} shopsNotConfirmed={notConfirmed} damaged={damaged} receptionDoneToday={receptionDoneToday} toSend={toSend} canSendOdoo={['admin', 'lab_manager'].includes(profile?.role ?? '')} today={today} />} initialGaps={gaps} schemaReady={schemaReady} odooMode={receptionOdooMode()} canSendOdoo={['admin', 'lab_manager'].includes(profile?.role ?? '')} extra={<><StuckInPanel /><OffslipPanel mode="open" /></>} extraClosed={<OffslipPanel mode="closed" />} />;
}
