import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sweepStuckShopIns } from '@/lib/reception-auto-in';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Hourly safety net (Axel, 2026-10-20): every REP the shop fully received in the app whose shop IN
// is still open on Odoo is retried when the reception is conforming. Non-conforming ones stay
// listed on /delivery-check/gaps ("Shop đã nhận đủ · Odoo chưa xác nhận").
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
  try {
    const r = await sweepStuckShopIns(db as any);
    return NextResponse.json({ ok: true, tried: r.tried, validated: r.validated, still: r.still.map(s => `${s.orderRef}:${s.lastError ?? '?'}`) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
