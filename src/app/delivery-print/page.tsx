import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { ensureDeliveryOrderChecklist } from '@/lib/delivery-check';
import { fetchSoLinePricing } from '@/lib/odoo-so-pricing';
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
export default async function DeliveryPrintPage({ searchParams }: { searchParams: { date?: string; orderRef?: string; validate?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const date = searchParams.date;
  const orderRef = searchParams.orderRef;
  if (!date || !orderRef) redirect('/delivery-check');

  const { header, lines } = await ensureDeliveryOrderChecklist(supabase, date, orderRef);

  // Sales-order print needs a price per line (Axel, 2026-08-11: "Sales order" print, amount
  // computed on delivered qty) — a live, order-scoped Odoo call, only paid when someone actually
  // opens this print page for an SO, not on every delivery-check view. Degrades to no pricing
  // (columns just omitted) if Odoo is unreachable rather than breaking the print entirely.
  let pricing: Awaited<ReturnType<typeof fetchSoLinePricing>> = null;
  if (header.source_type === 'sales_order') {
    try { pricing = await fetchSoLinePricing(orderRef); } catch { pricing = null; }
  }

  // ?validate=1 (Axel, 2026-08-18) — "À valider sur Odoo" link on the order page skips straight
  // to the validation pop-up instead of forcing another Imprimer click first (the order's already
  // been printed once by the time that link is even shown).
  return <DeliveryPrintView header={header} lines={lines} pricing={pricing} openValidate={searchParams.validate === '1'} />;
}
