import { NextResponse } from 'next/server';
import { getEventSalesLedgerAction } from '@/app/shop/actions';

// Read-only GET twin of getEventSalesLedgerAction (speed pass, 2026-10-09): the "Doanh thu" view
// is the heaviest read of the event, and as a server action a sale tapped right after opening it
// had to wait for it to finish. A plain GET runs beside the sales. Same session + event checks
// (the action itself does them), nothing written.
export const dynamic = 'force-dynamic';

export async function GET() {
  const res = await getEventSalesLedgerAction();
  return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
}
