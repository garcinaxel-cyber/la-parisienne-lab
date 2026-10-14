import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendAdminPush } from '@/lib/push-notify';
import { listDeliveryGaps } from '@/lib/reception-gaps';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily alert on shop reception gaps (Axel, 2026-10-14 — "5. ok fais le"): one admin push at
// ~9:00 VN listing gaps still undecided after 48h, damaged units not back at the Lab after
// 2 deliveries, and settled orders not yet sent to Odoo after 48h. Nothing when all is clean.
// Called by the Vercel cron (Authorization: Bearer CRON_SECRET) or by hand with ?secret=.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { gaps } = await listDeliveryGaps(db as any);
  const now = Date.now();
  const late = gaps.filter(g => g.overdue || (g.status === 'waiting_shop' && g.deadlineAt && now > new Date(g.deadlineAt).getTime()));
  const notBack = gaps.filter(g => g.returnOverdue);
  const unsent = gaps.filter(g => g.status === 'closed' && g.odooMode !== 'sent' && g.labCause !== 'shop_miscount'
    && !(g.kind === 'extra' && g.labCause !== 'lab_sent_extra') && g.deadlineAt && now > new Date(g.deadlineAt).getTime());
  if (!late.length && !notBack.length && !unsent.length) return NextResponse.json({ ok: true, count: 0 });
  const orders = (arr: typeof gaps) => Array.from(new Set(arr.map(g => g.orderRef))).slice(0, 3).join(', ');
  const vi: string[] = []; const en: string[] = [];
  if (late.length) { vi.push(`${late.length} lệch quá 48h (${orders(late)})`); en.push(`${late.length} gaps over 48h (${orders(late)})`); }
  if (notBack.length) { vi.push(`${notBack.length} hàng hỏng chưa về sau 2 chuyến (${orders(notBack)})`); en.push(`${notBack.length} damaged not back after 2 deliveries (${orders(notBack)})`); }
  if (unsent.length) { vi.push(`${unsent.length} dòng chưa gửi Odoo (${orders(unsent)})`); en.push(`${unsent.length} lines not sent to Odoo (${orders(unsent)})`); }
  await sendAdminPush(db as any,
    { title: 'Lệch giao hàng', body: `⚠ ${vi.join(' · ')}`, url: '/delivery-check/gaps', tag: 'reception-gaps' },
    { title: 'Delivery gaps', body: `⚠ ${en.join(' · ')}`, url: '/delivery-check/gaps', tag: 'reception-gaps' });
  return NextResponse.json({ ok: true, late: late.length, notBack: notBack.length, unsent: unsent.length });
}
