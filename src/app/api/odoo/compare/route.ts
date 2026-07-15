import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured } from '@/lib/odoo';
import { runOdooSync } from '@/lib/odoo-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// TEMPORARY read-only check — runs the Odoo↔app comparison WITHOUT persisting anything.
// Reports discrepancies on already-imported orders + orders in Odoo not yet imported.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  try {
    const r = await runOdooSync(supabase as any);
    const newRefs = Array.from(new Set((r.lines ?? []).map((l: any) => l.order_ref).filter(Boolean)));
    return NextResponse.json({
      imported_match_odoo: (r.changes?.length ?? 0) === 0,
      discrepancies_count: r.changes?.length ?? 0,
      discrepancies: (r.changes ?? []).map((c: any) => ({
        order_ref: c.order_ref, cancelled: c.cancelled,
        items: (c.items ?? []).map((it: any) => `${it.sku} ${it.old_qty}->${it.new_qty}`),
      })),
      new_orders_in_odoo_not_imported: newRefs.length,
      new_refs: newRefs.slice(0, 40),
      checked: { sales: r.stats?.sales_orders, replenishments: r.stats?.replenishments },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'compare failed' }, { status: 502 });
  }
}
