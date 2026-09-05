import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendTeamPush, type PushPayload } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Chef reminder for produced items not yet sent to stock (Axel, 2026-09-05: "une notifications
// pour les chefs quand ils ont pas envoye en stock leur produit", 1h after being marked
// produced). Marks each alerted row's stock_reminder_sent_at so a later run of this same check
// (every 30 min, see pg_cron) never re-sends for the same still-pending item — independent of
// how often the job fires. Called by pg_cron with ?secret=CRON_SECRET, same pattern as the
// other /api/odoo/* cron routes.
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
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // produced more than 1h ago

  const { data: rows, error } = await supabase
    .from('lab_assignments')
    .select('id, team, product_name_vi, qty_produced, produced_at')
    .eq('transferred', false)
    .not('produced_at', 'is', null)
    .lte('produced_at', cutoff)
    .is('stock_reminder_sent_at', null)
    .or('cancelled.is.null,cancelled.eq.false');
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  if (!rows?.length) return NextResponse.json({ notified: 0 });

  const byTeam = new Map<string, { id: string; label: string }[]>();
  for (const r of rows) {
    if (!r.team) continue;
    const list = byTeam.get(r.team) ?? [];
    list.push({ id: r.id, label: r.qty_produced > 1 ? `${r.product_name_vi} x${r.qty_produced}` : r.product_name_vi });
    byTeam.set(r.team, list);
  }

  const notifiedIds: string[] = [];
  for (const [team, items] of Array.from(byTeam.entries())) {
    const shown = items.slice(0, 3).map(i => i.label).join(', ');
    const rest = items.length > 3 ? ` +${items.length - 3}` : '';
    const viPayload: PushPayload = { title: 'La Parisienne Lab', body: `📦 Chưa gửi vào kho (>1h): ${shown}${rest}`, url: `/station/${team}` };
    const enPayload: PushPayload = { title: 'La Parisienne Lab', body: `📦 Not sent to stock yet (>1h): ${shown}${rest}`, url: `/station/${team}` };
    await sendTeamPush(supabase, team, viPayload, enPayload);
    for (const i of items) notifiedIds.push(i.id);
  }

  if (notifiedIds.length) {
    await supabase.from('lab_assignments').update({ stock_reminder_sent_at: new Date().toISOString() }).in('id', notifiedIds);
  }

  return NextResponse.json({ notified: notifiedIds.length });
}
