import { NextResponse } from 'next/server';
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMPORARY — Axel, 2026-09-07: one-off cancel of REP/2026/01367 (wrong delivery date,
// user will recreate cleanly). Verified live: picking LAB/OUT/03697 is already state
// "cancel" with 0 quantity moved (see chat), so rejecting the parent doc here does not
// touch any real stock movement. Bypasses cancelOdooOrderLine's state guard (which refuses
// "done") only after that same live re-check below confirms nothing shipped.
const DEBUG_KEY = '4ik7FDJYSbKV1nVwwv1sXpvLe2afgxgE';
const ORDER_REF = 'REP/2026/01367';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== DEBUG_KEY) return NextResponse.json({ error: 'nope' }, { status: 401 });
  if (!odooWriteConfigured()) return NextResponse.json({ error: 'odoo write not configured' }, { status: 503 });
  const dryRun = url.searchParams.get('dry') === '1';

  try {
    const reqs = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
      [[['name', '=', ORDER_REF]]], { fields: ['id', 'state'], limit: 1 });
    const reqDoc = reqs[0];
    if (!reqDoc) return NextResponse.json({ error: `${ORDER_REF} not found` }, { status: 404 });

    const pickings = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['origin', '=', ORDER_REF]]], { fields: ['id', 'name', 'state'] });
    const moves = pickings.length
      ? await odooExecute<any[]>('stock.move', 'search_read',
          [[['picking_id', 'in', pickings.map((p) => p.id)]]],
          { fields: ['picking_id', 'product_id', 'product_qty', 'quantity', 'state'] })
      : [];

    const anyMoved = moves.some((m) => m.state === 'done' || Number(m.quantity) > 0);
    const allPickingsCancelled = pickings.length > 0 && pickings.every((p) => p.state === 'cancel');

    const safe = allPickingsCancelled && !anyMoved;

    if (dryRun || !safe) {
      return NextResponse.json({ dryRun: true, safe, reqDoc, pickings, moves });
    }

    await odooExecuteWrite('stock.replenishment.request', 'write', [[reqDoc.id], { state: 'rejected' }]);
    const after = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
      [[['id', '=', reqDoc.id]]], { fields: ['id', 'name', 'state'] });

    return NextResponse.json({ ok: true, before: reqDoc, after: after[0], pickings, moves });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
