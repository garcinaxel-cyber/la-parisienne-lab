import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { odooConfigured, odooWriteConfigured, odooExecute, odooExecuteWrite } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// One-off diagnostic + fix (2026-09-05, Axel: order S03640 to Moon Flower printed at full
// public price on the /delivery-print page instead of Moon Flower's usual 50% wholesale rate —
// the order's pricelist was wrong at creation time, so sale.order.line carries discount=0 /
// full price_unit. /delivery-print reads price_subtotal live from Odoo (odoo-so-pricing.ts),
// so fixing THIS order's lines in Odoo is enough — no code/behavior change, nothing else is
// touched. Session+admin-role gated (same pattern as normal-order-time-debug), never a secret.
//
// action=lines (default): read-only preview of every real product line's current
// price_unit/discount/price_subtotal.
// action=apply: sets discount=<discount> (default 50) on every real product line of the given
// order — only lines with display_type=false (skips section/note lines), only lines whose
// discount does not already equal the target (idempotent retry-safe), never touches other
// orders. No state change needed first (unlike account.move, sale.order.line discount is
// editable even when the order is confirmed).
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  if (!odooConfigured()) return NextResponse.json({ error: 'ODOO_* not configured' }, { status: 503 });

  const url = new URL(req.url);
  const ref = url.searchParams.get('ref');
  if (!ref) return NextResponse.json({ error: 'missing ?ref=' }, { status: 400 });
  const action = url.searchParams.get('action') ?? 'lines';
  const targetDiscount = Number(url.searchParams.get('discount') ?? '50');

  try {
    const orders = await odooExecute<any[]>('sale.order', 'search_read',
      [[['name', '=', ref]]], { fields: ['id', 'name', 'partner_id', 'state', 'amount_total'] });
    const order = orders[0];
    if (!order) return NextResponse.json({ error: 'order not found', ref });

    const lines = await odooExecute<any[]>('sale.order.line', 'search_read',
      [[['order_id', '=', order.id], ['display_type', '=', false]]],
      { fields: ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'discount', 'price_subtotal'] });

    if (action === 'lines') {
      return NextResponse.json({ ref, order, lines });
    }

    if (action === 'apply') {
      if (!odooWriteConfigured()) return NextResponse.json({ error: 'ODOO_WRITE_* not configured' }, { status: 503 });
      const toUpdate = lines.filter(l => Number(l.discount ?? 0) !== targetDiscount);
      for (const l of toUpdate) {
        await odooExecuteWrite('sale.order.line', 'write', [[l.id], { discount: targetDiscount }]);
      }
      const after = await odooExecute<any[]>('sale.order.line', 'search_read',
        [[['order_id', '=', order.id], ['display_type', '=', false]]],
        { fields: ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'discount', 'price_subtotal'] });
      return NextResponse.json({ ref, updatedLineIds: toUpdate.map(l => l.id), linesAfter: after });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
