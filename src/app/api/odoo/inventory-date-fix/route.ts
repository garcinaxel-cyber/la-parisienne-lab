import { NextResponse } from 'next/server';
import { odooConfigured } from '@/lib/odoo';
import { inspectInventoryDateBatch, fixInventoryDateBatch } from '@/lib/odoo-inventory-date-fix';

export const dynamic = 'force-dynamic';
export const maxDuration = 270;

// One-off correction (2026-08-22, Axel) — see odoo-inventory-date-fix.ts for full context.
// GET with no ?apply=1 → read-only inspection (lists the matching lines + their create_date, so
// Axel can confirm they really are the 2026-06-30 batch before anything is written).
// GET with ?apply=1 → actually writes the corrected date. Requires ?target=YYYY-MM-DD.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) {
    return NextResponse.json({ error: 'ODOO_* not configured' }, { status: 503 });
  }

  const from = url.searchParams.get('from') ?? '2026-07-01 00:00:00';
  const to = url.searchParams.get('to') ?? '2026-07-30 23:59:59';
  const apply = url.searchParams.get('apply') === '1';
  const target = url.searchParams.get('target');
  const byLocation = url.searchParams.get('byLocation') === '1';

  try {
    const lines = await inspectInventoryDateBatch(from, to, { byLocation });
    if (!apply) {
      const createDateCounts: Record<string, number> = {};
      for (const l of lines) { const d = l.create_date.split(' ')[0]; createDateCounts[d] = (createDateCounts[d] ?? 0) + 1; }
      return NextResponse.json({
        count: lines.length,
        createDateSample: lines.slice(0, 20).map(l => ({ id: l.id, date: l.date, create_date: l.create_date, product: l.product, qty: l.qty, from: l.from, to: l.to })),
        createDateCounts,
      });
    }
    if (!target) return NextResponse.json({ error: 'Missing ?target=YYYY-MM-DD' }, { status: 400 });
    const result = await fixInventoryDateBatch(lines.map(l => l.id), target);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Inventory date fix failed' }, { status: 502 });
  }
}

// POST with an explicit, exact id list — used once Axel exported the real 286 rows from Odoo's
// own "Moves History" list view, so this never has to guess at a domain that reproduces the UI
// filter (61 / 154 / 536 were all wrong attempts). Body: { ids: number[], target: 'YYYY-MM-DD',
// apply?: boolean }. apply defaults to false (dry-run: just resolves+returns the current date of
// each id, confirming they're the right rows, before writing anything).
export async function POST(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) {
    return NextResponse.json({ error: 'ODOO_* not configured' }, { status: 503 });
  }
  const body = await req.json().catch(() => null);
  const ids: number[] = Array.isArray(body?.ids) ? body.ids.filter((n: any) => Number.isInteger(n)) : [];
  const target: string | undefined = body?.target;
  const apply = !!body?.apply;
  if (!ids.length) return NextResponse.json({ error: 'Missing ids[]' }, { status: 400 });

  try {
    if (!apply) {
      const { odooExecute } = await import('@/lib/odoo');
      const rows = await odooExecute<any[]>('stock.move.line', 'search_read',
        [[['id', 'in', ids]]], { fields: ['id', 'date', 'product_id', 'quantity', 'location_id', 'location_dest_id'] });
      return NextResponse.json({
        requested: ids.length,
        found: rows.length,
        missing: ids.filter(id => !rows.some((r: any) => r.id === id)),
        sample: rows.slice(0, 10).map((r: any) => ({ id: r.id, date: r.date, product: Array.isArray(r.product_id) ? r.product_id[1] : r.product_id })),
      });
    }
    if (!target) return NextResponse.json({ error: 'Missing target (YYYY-MM-DD)' }, { status: 400 });
    const result = await fixInventoryDateBatch(ids, target);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Inventory date fix failed' }, { status: 502 });
  }
}
