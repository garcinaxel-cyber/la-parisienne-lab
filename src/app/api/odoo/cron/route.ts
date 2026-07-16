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

    // Auto-cleanup: DRAFT imports whose order(s) were HARD-DELETED in Odoo are orphans
    // (never published, order gone). Remove them so they stop showing in the review list.
    // Only drafts whose EVERY ref is deleted are touched — published imports never are, and a
    // draft still holding a live order is left alone. Deletions on PUBLISHED orders instead
    // surface in the changes banner (via cancelledRefs) for a human to apply.
    // Runs AFTER the changes write so the orphan's stale banner row is cleared too.
    let cleanedDrafts = 0;
    if (result.deletedRefs.length) {
      const todayStr = new Date().toISOString().split('T')[0];
      const { data: draftRows } = await supabase
        .from('lab_imports').select('id').eq('status', 'draft').gte('delivery_date', todayStr);
      const draftIds = (draftRows ?? []).map((r: any) => r.id);
      if (draftIds.length) {
        const { data: dlines } = await supabase
          .from('lab_order_lines').select('import_id, order_ref').in('import_id', draftIds);
        const refsByImport = new Map<string, Set<string>>();
        for (const l of dlines ?? []) {
          (refsByImport.get(l.import_id) ?? refsByImport.set(l.import_id, new Set()).get(l.import_id)!).add(l.order_ref);
        }
        const deletedSet = new Set(result.deletedRefs);
        const orphanIds = Array.from(refsByImport.entries())
          .filter(([, refs]) => refs.size > 0 && Array.from(refs).every(r => deletedSet.has(r)))
          .map(([id]) => id);
        if (orphanIds.length) {
          const orphanRefs = orphanIds.flatMap(id => Array.from(refsByImport.get(id) ?? []));
          await supabase.from('lab_assignments').delete().in('import_id', orphanIds);
          await supabase.from('lab_order_lines').delete().in('import_id', orphanIds);
          await supabase.from('lab_imports').delete().in('id', orphanIds);
          if (orphanRefs.length) {
            await supabase.from('lab_odoo_changes').delete().in('order_ref', orphanRefs).eq('status', 'pending');
          }
          cleanedDrafts = orphanIds.length;
        }
      }
    }

    if (!lines.length) {
      return NextResponse.json({
        created_imports: 0, new_lines: 0,
        changes_detected: result.changes.length,
        deleted_refs: result.deletedRefs.length, cleaned_drafts: cleanedDrafts,
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
      deleted_refs: result.deletedRefs.length, cleaned_drafts: cleanedDrafts,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Cron sync failed' }, { status: 502 });
  }
}
