import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendTeamPush, sendAdminPush, awaitPush, type PushPayload } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// One-off admin utility (2026-09-16, Axel: REP/2026/01477 — Odoo moved the delivery date from
// 09-17 to 09-18 after import; lab_sync_date_alerts flagged it but, per odoo-sync.ts's own
// doc comment, a date move is never auto-applied — it can mean re-homing lab_order_lines/
// lab_assignments out of a shared import, so Axel does the actual DB move by hand. Once that
// move is done, chefs still need telling — the shared cards concern doesn't apply to the
// notification, so this is a plain, reusable "date changed, please note" push, not an automatic
// side effect of the sync. Same CRON_SECRET-gated posture as every other one-off /api/admin/*
// and /api/odoo/* utility route in this app — meant to be hit once by hand (or via this same
// URL again for the next such case), not wired into any cron.
//
// Query params: orderRef, team (comma-separated for multiple), productName, oldDate, newDate,
// shopName (optional, for context in the message). team accepts any lab_assignments team value
// ('baby_mama' | 'hung' | 'entremet' | 'baker').
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const orderRef = url.searchParams.get('orderRef');
  const teamsParam = url.searchParams.get('team');
  const productName = url.searchParams.get('productName') ?? '';
  const oldDate = url.searchParams.get('oldDate');
  const newDate = url.searchParams.get('newDate');
  const shopName = url.searchParams.get('shopName') ?? '';
  if (!orderRef || !teamsParam || !oldDate || !newDate) {
    return NextResponse.json({ error: 'Missing orderRef/team/oldDate/newDate' }, { status: 400 });
  }
  const teams = teamsParam.split(',').map(t => t.trim()).filter(Boolean);
  const validTeams = ['baby_mama', 'hung', 'entremet', 'baker'];
  const badTeam = teams.find(t => !validTeams.includes(t));
  if (badTeam) return NextResponse.json({ error: `Unknown team "${badTeam}"` }, { status: 400 });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const viBody = `${orderRef}${shopName ? ` (${shopName})` : ''} — ${productName ? `${productName}: ` : ''}ngày giao đổi từ ${oldDate} sang ${newDate}`;
  const enBody = `${orderRef}${shopName ? ` (${shopName})` : ''} — ${productName ? `${productName}: ` : ''}delivery date moved from ${oldDate} to ${newDate}`;
  const viPayload: PushPayload = { title: '📅 Đổi ngày giao', body: viBody };
  const enPayload: PushPayload = { title: '📅 Delivery date changed', body: enBody };

  await awaitPush(Promise.all([
    ...teams.map(team => sendTeamPush(supabase, team, viPayload, enPayload)),
    sendAdminPush(supabase, viPayload, enPayload),
  ]));

  return NextResponse.json({ ok: true, orderRef, teams, oldDate, newDate });
}
