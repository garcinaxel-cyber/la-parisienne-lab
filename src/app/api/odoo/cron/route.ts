import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured } from '@/lib/odoo';
import { runOdooSync } from '@/lib/odoo-sync';
import { consolidateLines } from '@/lib/excel-parser';
import { persistImportsFromLines } from '@/lib/import-persist';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Hourly auto-sync (called by pg_cron / external scheduler with ?secret=CRON_SECRET).
// PRUDENT mode: new orders are imported as DRAFTS — an assistant reviews and publishes.
// Modifications/cancellations are never auto-applied; they surface in the app for review.
// Uses the SAME persistence path as the manual publish flow (persistImportsFromLines).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (ODOO_* / SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const result = await runOdooSync(supabase as any);
    const lines = result.lines;

    // Persist detected modifications/cancellations for later human review.
    if (result.changes.length) {
      const dateByRef: Record<string, string> = {};
      for (const l of lines) if (l.order_ref && l.delivery_date) dateByRef[l.order_ref] = l.delivery_date;
      const refs = result.changes.map(c => c.order_ref);
      await supabase.from('lab_odoo_changes').delete().in('order_ref', refs).eq('status', 'pending');
      await supabase.from('lab_odoo_changes').insert(result.changes.map(c => ({
        order_ref: c.order_ref, cancelled: c.cancelled, items: c.items,
        delivery_date: dateByRef[c.order_ref] ?? null, status: 'pending',
      })));
    }

    if (!lines.length) {
      return NextResponse.json({
        created_imports: 0, new_lines: 0,
        changes_detected: result.changes.length,
        checked: { sales: result.stats.sales_orders, replenishments: result.stats.replenishments },
      });
    }

    // Consolidate (patch variant labels from fiches) and persist via the SHARED path
    const variantRows = (await supabase.from('lab_fiche_variants')
      .select('sku, label').in('sku', Array.from(new Set(lines.map((l: any) => l.product_sku).filter(Boolean))))).data ?? [];
    const labelBySku: Record<string, string> = {};
    for (const v of variantRows) if (v.sku) labelBySku[v.sku] = v.label;
    const consolidated = consolidateLines(lines.map((l: any) => ({ ...l, variant_label: labelBySku[l.product_sku] ?? l.variant_label })));

    const sourceTypeByRef: Record<string, string> = {};
    for (const l of lines) if (l.order_ref) sourceTypeByRef[l.order_ref] = l.source_type;

    const { createdImports, error } = await persistImportsFromLines(supabase, consolidated, {
      status: 'draft',
      orderStates: result.stats.order_states,
      sourceTypeByRef,
      auto: true,
    });
    if (error) return NextResponse.json({ error }, { status: 502 });

    return NextResponse.json({
      created_imports: createdImports,
      new_lines: lines.length,
      changes_detected: result.changes.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Cron sync failed' }, { status: 502 });
  }
}
