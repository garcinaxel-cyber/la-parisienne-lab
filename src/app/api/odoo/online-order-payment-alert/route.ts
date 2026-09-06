import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendShopPush, sendAdminPush, type PushPayload } from '@/lib/push-notify';
import { ONLINE_PUSH_KEY } from '@/lib/online-sales';

export const dynamic = 'force-dynamic';

// Late-payment alert for the online-sales interface (Axel, 2026-09-06: 24h after the order is
// delivered — by lab OR by shop, whichever happens first — if it isn't marked 'paid' yet, push
// her + admin once. Called by pg_cron every 30 min (registered only once this feature reaches
// production — see lab_v69_online_sales.sql's comment; NOT scheduled yet on the preview build).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: pending } = await supabase
    .from('lab_online_orders')
    .select('order_batch_id, shop_delivered, shop_delivered_at, created_at')
    .neq('payment_status', 'paid')
    .is('payment_alert_sent_at', null);
  if (!pending?.length) return NextResponse.json({ ok: true, checked: 0, alerted: 0 });

  const batchIds = pending.map(p => p.order_batch_id);
  const { data: lines } = await supabase.from('lab_manual_cakes')
    .select('order_batch_id, product_name_vi, matched_order_ref, customer_name')
    .in('order_batch_id', batchIds);
  const linesByBatch = new Map<string, any[]>();
  for (const l of lines ?? []) {
    const arr = linesByBatch.get(l.order_batch_id) ?? [];
    arr.push(l); linesByBatch.set(l.order_batch_id, arr);
  }
  const orderRefs = Array.from(new Set((lines ?? [])
    .map((l: any) => l.matched_order_ref)
    .filter((r: string | null): r is string => !!r && r !== '__pending_create__')));
  const { data: deliveries } = orderRefs.length
    ? await supabase.from('lab_delivery_orders').select('order_ref, status, validated_at').in('order_ref', orderRefs).eq('status', 'validated')
    : { data: [] as any[] };
  const labDeliveredAtByRef = new Map((deliveries ?? []).map((d: any) => [d.order_ref, d.validated_at as string]));

  let alerted = 0;
  const HOUR_MS = 3600 * 1000;
  for (const o of pending) {
    const ls = linesByBatch.get(o.order_batch_id) ?? [];
    const orderRef = ls.find(l => l.matched_order_ref && l.matched_order_ref !== '__pending_create__')?.matched_order_ref ?? null;
    const labDeliveredAt = orderRef ? labDeliveredAtByRef.get(orderRef) : undefined;
    const deliveredAt = [labDeliveredAt, o.shop_delivered ? o.shop_delivered_at : undefined]
      .filter(Boolean)
      .map((d: string) => new Date(d).getTime())
      .sort((a, b) => a - b)[0];
    if (!deliveredAt) continue; // not delivered by either signal yet — nothing to alert on
    if (Date.now() - deliveredAt < 24 * HOUR_MS) continue;

    const label = ls[0]?.product_name_vi ? `${ls[0].product_name_vi}${ls.length > 1 ? ` +${ls.length - 1}` : ''}` : 'đơn hàng';
    const who = ls[0]?.customer_name ? ` (${ls[0].customer_name})` : '';
    const viPayload: PushPayload = { title: 'La Parisienne Lab', body: `⚠ Đơn ${orderRef ?? ''} ${label}${who} chưa thanh toán sau 24h giao hàng`, url: '/online-orders' };
    const enPayload: PushPayload = { title: 'La Parisienne Lab', body: `⚠ Order ${orderRef ?? ''} ${label}${who} still unpaid 24h after delivery`, url: '/online-orders' };
    await sendShopPush(supabase, ONLINE_PUSH_KEY, viPayload);
    await sendAdminPush(supabase, viPayload, enPayload);
    await supabase.from('lab_online_orders').update({ payment_alert_sent_at: new Date().toISOString() }).eq('order_batch_id', o.order_batch_id);
    alerted++;
  }

  return NextResponse.json({ ok: true, checked: pending.length, alerted });
}
