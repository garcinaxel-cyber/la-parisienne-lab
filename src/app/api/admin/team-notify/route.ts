import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendTeamPush, awaitPush, type PushPayload } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Generic one-off admin utility (2026-09-22, Axel: REP/2026/01617 — a birthday-cake
// replenishment created directly in Odoo had 2 of its 3 lines missing a production card on the
// app side; once the missing cards were reconstructed by hand, Axel asked to "notifie les chefs
// via notif en viet"). order-date-change-notify/route.ts already set the precedent for this shape
// (CRON_SECRET-gated GET, hit once by hand, no cron wiring) but is hardcoded to the date-change
// message. This is the same posture with a free-form title/body instead, so the next ad-hoc
// "just tell the team" case doesn't need its own route.
//
// Query params: team (comma-separated, any of baby_mama|hung|entremet|baker|admin_shop_relay),
// titleVi, bodyVi (required), titleEn, bodyEn (optional — falls back to the vi copy for any
// subscriber with lang='en'), url (optional, opens this path in-app on tap).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const teamsParam = url.searchParams.get('team');
  const titleVi = url.searchParams.get('titleVi');
  const bodyVi = url.searchParams.get('bodyVi');
  const titleEn = url.searchParams.get('titleEn');
  const bodyEn = url.searchParams.get('bodyEn');
  const linkUrl = url.searchParams.get('url') ?? undefined;
  if (!teamsParam || !titleVi || !bodyVi) {
    return NextResponse.json({ error: 'Missing team/titleVi/bodyVi' }, { status: 400 });
  }
  const teams = teamsParam.split(',').map(t => t.trim()).filter(Boolean);
  const validTeams = ['baby_mama', 'hung', 'entremet', 'baker', 'admin_shop_relay'];
  const badTeam = teams.find(t => !validTeams.includes(t));
  if (badTeam) return NextResponse.json({ error: `Unknown team "${badTeam}"` }, { status: 400 });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const viPayload: PushPayload = { title: titleVi, body: bodyVi, url: linkUrl };
  const enPayload: PushPayload | undefined = titleEn && bodyEn ? { title: titleEn, body: bodyEn, url: linkUrl } : undefined;

  await awaitPush(Promise.all(teams.map(team => sendTeamPush(supabase, team, viPayload, enPayload))));

  return NextResponse.json({ ok: true, teams, titleVi, bodyVi });
}
