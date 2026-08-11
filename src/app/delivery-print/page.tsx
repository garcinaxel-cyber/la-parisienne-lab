import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { ensureDeliveryOrderChecklist } from '@/lib/delivery-check';
import DeliveryPrintView from './DeliveryPrintView';

export const revalidate = 0;

// Top-level route OUTSIDE the (app) route group on purpose — (app)/layout.tsx renders the
// Sidebar + top nav around every page nested under it, which is wrong for a page meant to be
// printed standalone (2026-08-11: Axel's preview screenshot showed the full app chrome sitting
// above the printed document). Previously lived at (app)/delivery-check/print — moved here so
// it only inherits the bare root layout (html/body + i18n, no nav).
//
// Query-param route (?date=&orderRef=) rather than nesting under the [...orderRef] catch-all —
// order_ref can itself contain slashes (REP/2026/00985), which would make an extra path segment
// under it ambiguous to parse back apart. Kept as its own top-level page for that reason.
export default async function DeliveryPrintPage({ searchParams }: { searchParams: { date?: string; orderRef?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const date = searchParams.date;
  const orderRef = searchParams.orderRef;
  if (!date || !orderRef) redirect('/delivery-check');

  const { header, lines } = await ensureDeliveryOrderChecklist(supabase, date, orderRef);

  return <DeliveryPrintView header={header} lines={lines} />;
}
