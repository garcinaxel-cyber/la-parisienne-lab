import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { getActiveEventById } from '@/lib/event-shops';
import { readEventIdFromCookie } from '@/lib/event-session';
import ShopView from '@/app/shop/ShopView';

export const dynamic = 'force-dynamic';

// The event's own screens for an admin or the lab manager (Axel, 2026-10-07: "je veux aussi que
// l'event puisse être accessible dans l'interface admin lab manager, je dois pouvoir rentrer
// dans l'event facilement"). Reached from the "Open" button of /admin/events, which sets the
// signed event cookie first (enterEventAsStaffAction) — a cookie cannot be written while a page
// renders, so arriving here without it (old link, expired cookie, another event still open in
// this browser) simply goes back to the list to click Open again.
//
// Same component as the staff's own screen (ShopView), same "acting on behalf" flag as
// /admin/shop-access/[shopName]; shopName is the event's name, which is exactly what every
// action resolves to anyway while the cookie is set.
export default async function EventStorePage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin' && profile?.role !== 'lab_manager') redirect('/dashboard');

  const event = await getActiveEventById(params.id);
  if (!event || readEventIdFromCookie() !== event.id) redirect('/admin/events');

  return <ShopView shopName={event.name} readOnly initialTab="caisse" exitEventHref="/admin/events" />;
}
