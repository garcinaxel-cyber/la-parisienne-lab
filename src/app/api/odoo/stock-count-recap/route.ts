import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendAdminPush, type PushPayload } from '@/lib/push-notify';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Nightly admin recap of today's shop stock counts (Axel, 2026-09-06: "savoir aussi qui ne l'a
// PAS fait"). One push to the admin account at 22:45 VN listing, per portal shop, whether a
// count was saved today (SKU count, number of sessions, whether it was explicitly finished) or
// nothing at all. Called by pg_cron with ?secret=CRON_SECRET, same pattern as chef-stock-reminder.
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

  // Today in VN (the count_date convention used by the shop portal).
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const [{ data: counts, error }, { data: done }] = await Promise.all([
    supabase.from('lab_shop_stock_counts').select('shop_name, session_seq, sku').eq('count_date', today),
    supabase.from('lab_shop_stock_sessions_done').select('shop_name, session_seq, sku_count, valuation').eq('count_date', today),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });

  const byShop = new Map<string, { skus: Set<string>; sessions: Set<number> }>();
  for (const r of counts ?? []) {
    const cur = byShop.get(r.shop_name) ?? { skus: new Set<string>(), sessions: new Set<number>() };
    cur.skus.add(r.sku as string); cur.sessions.add(Number(r.session_seq));
    byShop.set(r.shop_name, cur);
  }
  const doneByShop = new Map<string, number>();
  for (const d of done ?? []) doneByShop.set(d.shop_name, (doneByShop.get(d.shop_name) ?? 0) + 1);

  const shortName = (s: string) => s.replace(/^La Paris\s+/i, '');
  const linesVi: string[] = []; const linesEn: string[] = [];
  let missing = 0;
  for (const shop of PORTAL_SHOP_NAMES) {
    const c = byShop.get(shop);
    const finished = doneByShop.get(shop) ?? 0;
    if (!c) {
      missing += 1;
      linesVi.push(`✗ ${shortName(shop)}: chưa kiểm kho`);
      linesEn.push(`✗ ${shortName(shop)}: no count`);
      continue;
    }
    const sess = c.sessions.size > 1 ? ` · ${c.sessions.size} đợt` : '';
    const sessEn = c.sessions.size > 1 ? ` · ${c.sessions.size} sessions` : '';
    const mark = finished > 0 ? '✓' : '◐';
    linesVi.push(`${mark} ${shortName(shop)}: ${c.skus.size} SP${sess}${finished > 0 ? '' : ' (chưa bấm hoàn tất)'}`);
    linesEn.push(`${mark} ${shortName(shop)}: ${c.skus.size} SKUs${sessEn}${finished > 0 ? '' : ' (not marked finished)'}`);
  }

  // Inter-shop transfers today (Axel, 2026-09-07): sent / received today, plus anything still
  // waiting for its destination shop whatever the day it was sent.
  try {
    const dayStartUtc = new Date(`${today}T00:00:00+07:00`).toISOString();
    const [{ data: sentToday }, { data: recvToday }, { data: pending }] = await Promise.all([
      supabase.from('lab_shop_transfers').select('id').gte('sent_at', dayStartUtc).neq('status', 'cancelled'),
      supabase.from('lab_shop_transfers').select('id').gte('received_at', dayStartUtc).eq('status', 'received'),
      supabase.from('lab_shop_transfers').select('ref, from_shop, to_shop').eq('status', 'sent').limit(50),
    ]);
    const nSent = sentToday?.length ?? 0, nRecv = recvToday?.length ?? 0, nPend = pending?.length ?? 0;
    if (nSent || nRecv || nPend) {
      const short = (x: string) => x.replace(/^La Paris\s+/i, '');
      const pendTxt = (pending ?? []).slice(0, 3).map((p: any) => `${p.ref} ${short(p.from_shop)}→${short(p.to_shop)}`).join(', ');
      linesVi.push(`🔁 Chuyển kho: ${nSent} gửi · ${nRecv} nhận · ${nPend} chờ nhận${nPend ? ` (${pendTxt}${nPend > 3 ? '…' : ''})` : ''}`);
      linesEn.push(`🔁 Transfers: ${nSent} sent · ${nRecv} received · ${nPend} pending${nPend ? ` (${pendTxt}${nPend > 3 ? '…' : ''})` : ''}`);
    }
  } catch { /* recap stays useful without this line */ }

  const viPayload: PushPayload = { title: `📋 Kiểm kho hôm nay${missing ? ` — ${missing} shop chưa làm` : ' — đủ'}`, body: linesVi.join('\n') };
  const enPayload: PushPayload = { title: `📋 Stock counts today${missing ? ` — ${missing} shop(s) missing` : ' — all done'}`, body: linesEn.join('\n') };
  await sendAdminPush(supabase, viPayload, enPayload);

  return NextResponse.json({ date: today, shops: PORTAL_SHOP_NAMES.length, counted: byShop.size, missing, lines: linesEn });
}
