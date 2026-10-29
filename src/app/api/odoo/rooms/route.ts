import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooWriteConfigured } from '@/lib/odoo';
import { pushPendingSlips, pushPendingRoomCounts, topUpRecentRoomMOs, roomsLinkStartIso } from '@/lib/rooms-odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Rooms linked to Odoo (2026-10-29) — every 15 min (pg_cron "rooms-odoo", ?secret=CRON_SECRET):
//   1. slips whose Odoo transfer failed or never ran;
//   2. packaging / semi-finished components of room MOs done today and yesterday (LAB/Stock → room);
//   3. confirmed room counts waiting for their day's MOs, or that failed.
// Does nothing while ROOMS_LINK_START_DAY is not set.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!roomsLinkStartIso()) return NextResponse.json({ off: true });
  if (!odooWriteConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const out: Record<string, any> = {};
  try { out.slips = await pushPendingSlips(db); } catch (e: any) { out.slips = { error: String(e?.message ?? e) }; }
  try { out.topups = await topUpRecentRoomMOs(db); } catch (e: any) { out.topups = { error: String(e?.message ?? e) }; }
  try { out.counts = await pushPendingRoomCounts(db); } catch (e: any) { out.counts = { error: String(e?.message ?? e) }; }
  return NextResponse.json(out);
}
