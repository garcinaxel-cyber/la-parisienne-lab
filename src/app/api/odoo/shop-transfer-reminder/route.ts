import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendShopPush, sendAdminPush, type PushPayload } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Inter-shop transfers not yet received 24h after being sent (Axel, 2026-09-07): one push to the
// destination shop (and admin) per transfer, at most once per VN day (reminder_sent_on), until it
// is received or cancelled. Called hourly 08:00-21:00 VN by pg_cron with ?secret=CRON_SECRET —
// same pattern as stock-count-recap; the middleware exempts this path.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabase.from('lab_shop_transfers')
    .select('id, ref, from_shop, to_shop, sent_at, line_count, unit_count, reminder_sent_on')
    .eq('status', 'sent').lte('sent_at', cutoff).order('sent_at').limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });

  const due = (rows ?? []).filter((r: any) => r.reminder_sent_on !== today);
  const short = (x: string) => x.replace(/^La Paris\s+/i, '');
  let sent = 0;
  for (const t of due) {
    const hours = Math.round((Date.now() - new Date(t.sent_at).getTime()) / 3600_000);
    const viPayload: PushPayload = { title: t.to_shop, body: `⏰ Chuyển kho ${t.ref} từ ${short(t.from_shop)} đã gửi ${hours}h trước mà chưa xác nhận nhận (${t.line_count} SP · ${t.unit_count} cái) — vào tab Chuyển kho để nhận hoặc báo ${short(t.from_shop)} huỷ`, tag: `trf-reminder-${t.id}` };
    const enPayload: PushPayload = { title: t.to_shop, body: `⏰ Transfer ${t.ref} from ${short(t.from_shop)} sent ${hours}h ago, still not received (${t.line_count} SKUs · ${t.unit_count} units)`, tag: `trf-reminder-${t.id}` };
    await Promise.all([sendShopPush(supabase, t.to_shop, viPayload), sendAdminPush(supabase, viPayload, enPayload)]);
    await supabase.from('lab_shop_transfers').update({ reminder_sent_on: today }).eq('id', t.id);
    sent += 1;
  }
  return NextResponse.json({ date: today, pending: rows?.length ?? 0, reminded: sent });
}
