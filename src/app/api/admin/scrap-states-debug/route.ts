import { NextResponse } from 'next/server';
import { odooConfigured, odooExecuteWrite } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// Read-only diagnostic (2026-09-04, Axel: "verifie que les Scrap de Bà Triệu et Time City sont
// correctement saisie sur odoo via l app") — batches stock.scrap.read across many ids in one call
// so a shop's whole lab_shop_losses.odoo_scrap_id history can be cross-checked against Odoo's
// real state. Needed on top of the app-level odoo_scrap_id/odoo_sync_error columns because of the
// 2026-08-27 finding in odoo-scrap.ts: action_validate() can return an insufficient-qty wizard
// action instead of throwing, which (before that fix) left a scrap silently stuck at
// state='draft' in Odoo despite odoo_scrap_id being set locally. Same CRON_SECRET pattern as
// /api/odoo/scrap-debug — deliberately a narrow, single-purpose, secret-gated, read-only route
// (never a write) rather than widening auth on /api/admin/odoo-scrap-debug, which also exposes
// write actions (validate/cancel/testwizard/invset/...) that must stay behind a real staff
// session. Called by hand via curl, no session. No writes, ever.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) {
    return NextResponse.json({ error: 'ODOO_* not configured' }, { status: 503 });
  }
  const idsParam = url.searchParams.get('ids') ?? '';
  const ids = idsParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  if (!ids.length) return NextResponse.json({ error: 'Missing ?ids=1,2,3' }, { status: 400 });

  try {
    const rows = await odooExecuteWrite<any[]>('stock.scrap', 'read', [ids], { fields: ['state', 'name', 'scrap_qty'] });
    const foundIds = new Set(rows.map(r => r.id));
    const missing = ids.filter(id => !foundIds.has(id));
    const notDone = rows.filter(r => r.state !== 'done');
    const stateCounts: Record<string, number> = {};
    for (const r of rows) stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1;
    return NextResponse.json({ requested: ids.length, found: rows.length, missing, stateCounts, notDone });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
