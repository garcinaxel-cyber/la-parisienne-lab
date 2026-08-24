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

  try {
    const lines = await inspectInventoryDateBatch(from, to);
    if (!apply) {
      return NextResponse.json({
        count: lines.length,
        createDateSample: lines.slice(0, 20).map(l => ({ id: l.id, date: l.date, create_date: l.create_date, product: l.product, qty: l.qty })),
        allCreateDates: Array.from(new Set(lines.map(l => l.create_date.split(' ')[0]))).sort(),
      });
    }
    if (!target) return NextResponse.json({ error: 'Missing ?target=YYYY-MM-DD' }, { status: 400 });
    const result = await fixInventoryDateBatch(lines.map(l => l.id), target);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Inventory date fix failed' }, { status: 502 });
  }
}
