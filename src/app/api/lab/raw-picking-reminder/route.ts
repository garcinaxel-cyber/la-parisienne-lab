import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendUsersPush, sendAdminPush, type PushPayload } from '@/lib/push-notify';
import { TEAM_SHORT } from '@/lib/raw-materials';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Storage forgets to confirm a chef's withdrawal slip (Axel, 2026-10-09: "hien confirm d'abord mais je
// pense qu'il risque d'oublier de confirmer des fois"). Every 10 min (pg_cron, ?secret=CRON_SECRET):
// - slip waiting >= 10 min, not reminded in the last 10 min -> push again to the purchasing role;
// - slip waiting >= 30 min, never escalated -> one push to the admin (Axel).
// Nothing is sent when nothing waits.
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
  const now = Date.now();
  const { data: ws, error } = await db.from('lab_raw_withdrawals')
    .select('id, no, team, taken_by, created_at, reminded_at, escalated_at')
    .eq('status', 'to_confirm').lte('created_at', new Date(now - 10 * 60000).toISOString())
    .order('created_at', { ascending: true }).limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  if (!ws?.length) return NextResponse.json({ ok: true, waiting: 0 });

  const mins = (iso: string) => Math.round((now - new Date(iso).getTime()) / 60000);
  const label = (w: any) => `#${w.no} ${TEAM_SHORT[w.team]?.vi ?? w.team}`;
  const iso = new Date(now).toISOString();

  const toRemind = ws.filter(w => !w.reminded_at || now - new Date(w.reminded_at).getTime() >= 10 * 60000 - 30000);
  if (toRemind.length) {
    const { data: ps } = await db.from('profiles').select('id').eq('role', 'purchasing');
    const ids = (ps ?? []).map(p => p.id as string);
    const oldest = mins(toRemind[0].created_at);
    const p: PushPayload = {
      title: 'La Parisienne Lab',
      body: `⏰ ${toRemind.length} phiếu lấy kho chờ xác nhận (lâu nhất ${oldest} phút): ${toRemind.slice(0, 4).map(label).join(', ')}`,
      url: '/purchasing?tab=storage', tag: 'raw-pick-reminder',
    };
    await sendUsersPush(db, ids, p, p);
    await db.from('lab_raw_withdrawals').update({ reminded_at: iso }).in('id', toRemind.map(w => w.id));
  }

  const toEscalate = ws.filter(w => !w.escalated_at && mins(w.created_at) >= 30);
  if (toEscalate.length) {
    const list = toEscalate.slice(0, 4).map(w => `${label(w)} (${mins(w.created_at)} phút)`).join(', ');
    const listEn = toEscalate.slice(0, 4).map(w => `${label(w)} (${mins(w.created_at)} min)`).join(', ');
    await sendAdminPush(db,
      { title: 'La Parisienne Lab', body: `⚠ Phiếu lấy kho chưa được kho xác nhận sau 30 phút: ${list}`, url: '/purchasing?tab=storage', tag: 'raw-pick-escalate' },
      { title: 'La Parisienne Lab', body: `⚠ Withdrawal slip(s) not confirmed by storage after 30 min: ${listEn}`, url: '/purchasing?tab=storage', tag: 'raw-pick-escalate' });
    await db.from('lab_raw_withdrawals').update({ escalated_at: iso }).in('id', toEscalate.map(w => w.id));
  }
  return NextResponse.json({ ok: true, waiting: ws.length, reminded: toRemind.length, escalated: toEscalate.length });
}
