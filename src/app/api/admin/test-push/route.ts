import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { pushConfigured, sendAdminPush, sendShopPush, sendTeamPush } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';

// One-off diagnostic (2026-09-05, Axel: "essaie de push une fake notif pour voir si ca marche
// bien" after fixing the admin push resubscribe + the stock-count completion threshold). Sends
// a clearly-marked test payload through the real send path so we can confirm delivery end to
// end without touching any real order/delivery/inventory data. Session+admin-role gated, same
// pattern as normal-order-time-debug / fix-so-discount — never a secret.
//
// ?target=admin (default): sendAdminPush — reaches every all_teams=true subscriber (Axel).
// ?target=shop&shop=<exact shop_name>: sendShopPush to that shop's own subscribers.
// ?target=team&team=<team>: sendTeamPush to that station's subscribers.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  if (!pushConfigured()) return NextResponse.json({ error: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not configured' }, { status: 503 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, { status: 503 });
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const url = new URL(req.url);
  const target = url.searchParams.get('target') ?? 'admin';
  const stamp = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const viPayload = { title: 'La Parisienne Lab (TEST)', body: `🧪 Test push — ${stamp}. Bỏ qua nếu bạn nhận được cái này.` };
  const enPayload = { title: 'La Parisienne Lab (TEST)', body: `🧪 Test push — ${stamp}. Ignore if you receive this.` };

  if (target === 'shop') {
    const shop = url.searchParams.get('shop');
    if (!shop) return NextResponse.json({ error: 'missing ?shop=' }, { status: 400 });
    const { count } = await service.from('lab_shop_push_subscriptions').select('id', { count: 'exact', head: true }).eq('shop_name', shop);
    await sendShopPush(service, shop, viPayload, enPayload);
    return NextResponse.json({ ok: true, target: 'shop', shop, subscriberCount: count ?? 0 });
  }
  if (target === 'team') {
    const team = url.searchParams.get('team');
    if (!team) return NextResponse.json({ error: 'missing ?team=' }, { status: 400 });
    const { count } = await service.from('lab_push_subscriptions').select('id', { count: 'exact', head: true }).or(`team.eq.${team},all_teams.eq.true`);
    await sendTeamPush(service, team, viPayload, enPayload);
    return NextResponse.json({ ok: true, target: 'team', team, subscriberCount: count ?? 0 });
  }
  const { count } = await service.from('lab_push_subscriptions').select('id', { count: 'exact', head: true }).eq('all_teams', true);
  await sendAdminPush(service, viPayload, enPayload);
  return NextResponse.json({ ok: true, target: 'admin', subscriberCount: count ?? 0 });
}
