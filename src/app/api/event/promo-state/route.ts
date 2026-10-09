import { NextResponse } from 'next/server';
import { getEventPromoStateAction } from '@/app/shop/actions';

// Read-only GET twin of getEventPromoStateAction (speed pass, 2026-10-09). The event till polls
// the promo switches every minute; as a server action that poll waited in the same one-at-a-time
// queue as the sales themselves. A plain GET runs beside them. Same session + event checks (the
// action itself does them), nothing written.
export const dynamic = 'force-dynamic';

export async function GET() {
  const res = await getEventPromoStateAction();
  return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
}
