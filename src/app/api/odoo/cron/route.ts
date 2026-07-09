import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured } from '@/lib/odoo';
import { runOdooSync } from '@/lib/odoo-sync';
import { consolidateLines } from '@/lib/excel-parser';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

// Hourly auto-sync (called by pg_cron / external scheduler with ?secret=CRON_SECRET).
// PRUDENT mode: new orders are imported as DRAFTS — an assistant reviews and publishes.
// Modifications/cancellations are never auto-applied; they surface in the Import screen.
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
    // Never auto-applied — surfaced as a "changes to review" queue in the app.
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

    // Enrich with fiche/variant (same as the manual publish flow)
    const skus = Array.from(new Set(lines.map((l: any) => l.product_sku).filter(Boolean)));
    const { data: variantRows } = await supabase
      .from('lab_fiche_variants').select('id, sku, label, fiche_id, image_url').in('sku', skus);
    const vBySku: Record<string, any> = {};
    for (const v of variantRows ?? []) if (v.sku) vBySku[v.sku] = v;
    const ficheIds = Array.from(new Set((variantRows ?? []).map(v => v.fiche_id).filter(Boolean)));
    const { data: ficheRows } = ficheIds.length
      ? await supabase.from('lab_fiche_meta').select('id, name_en, image_url').in('id', ficheIds)
      : { data: [] as any[] };
    const fById: Record<string, any> = {};
    for (const f of ficheRows ?? []) fById[f.id] = f;

    // Consolidate into assignments (patch variant labels from fiches first)
    const consolidated = consolidateLines(lines.map((l: any) => ({
      ...l, variant_label: vBySku[l.product_sku]?.label ?? l.variant_label,
    })));

    const today = new Date().toISOString().split('T')[0];
    const byDate = new Map<string, typeof consolidated>();
    for (const line of consolidated) {
      const date = line.delivery_date || today;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(line);
    }

    let createdImports = 0;
    for (const [date, dateLines] of Array.from(byDate.entries()).sort()) {
      const { count } = await supabase
        .from('lab_imports').select('*', { count: 'exact', head: true }).eq('delivery_date', date);
      const orderRefs = Array.from(new Set(dateLines.flatMap(l => l.breakdown.map(b => b.order_ref)).filter(Boolean)));

      const { data: importRow, error: impErr } = await supabase.from('lab_imports').insert({
        delivery_date: date,
        order_number: (count ?? 0) + 1,
        type: 'daily',
        shipped_from_lab: false,
        notes: 'Auto-sync Odoo',
        status: 'draft',
        filename_sales: 'Odoo auto-sync',
        control_report: {
          totals: {
            excel_lines: dateLines.length,
            excel_qty: dateLines.reduce((s, l) => s + l.total_qty, 0),
            kept_lines: dateLines.length,
            kept_qty: dateLines.reduce((s, l) => s + l.total_qty, 0),
            orders: orderRefs.length, skipped: 0, excluded: 0,
          },
          by_order: orderRefs.map(ref => {
            const bs = dateLines.flatMap(l => l.breakdown.filter(b => b.order_ref === ref));
            return { order_ref: ref, lines: bs.length, qty: bs.reduce((a, b) => a + b.qty, 0) };
          }),
          order_states: Object.fromEntries(orderRefs.map(r => [r, result.stats.order_states[r]]).filter(([, s]) => s)),
          files: ['Odoo auto-sync'],
          auto: true,
        },
      }).select('id').single();
      if (impErr || !importRow) continue;

      const assignable = dateLines.filter(l => TEAMS.includes(l.team));
      if (assignable.length) {
        await supabase.from('lab_assignments').insert(assignable.map((line, idx) => {
          const v = vBySku[line.product_sku] ?? null;
          const f = v ? fById[v.fiche_id] ?? null : null;
          return {
            import_id: importRow.id,
            team: line.team,
            fiche_id: v?.fiche_id ?? null,
            variant_id: v?.id ?? null,
            product_name_vi: line.product_name_vi,
            product_name_en: f?.name_en ?? '',
            image_url: v?.image_url ?? f?.image_url ?? null,
            variant_label: line.variant_label,
            total_qty: line.total_qty,
            qty_to_produce: line.total_qty,
            qty_produced: 0,
            status: 'pending',
            sort_order: idx,
            breakdown: line.breakdown ?? [],
          };
        }));
      }

      const olRows = dateLines.flatMap(line => line.breakdown.map(b => ({
        import_id: importRow.id,
        source_type: lines.find((r: any) => r.order_ref === b.order_ref)?.source_type ?? 'sales_order',
        order_ref: b.order_ref,
        shop_name: b.shop_name,
        product_sku: line.product_sku,
        product_name_vi: line.product_name_vi,
        team: line.team,
        variant_label: line.variant_label,
        qty: b.qty,
        delivery_date: date,
        delivery_time: b.delivery_time ?? null,
        fiche_id: vBySku[line.product_sku]?.fiche_id ?? null,
        variant_id: vBySku[line.product_sku]?.id ?? null,
      })));
      if (olRows.length) await supabase.from('lab_order_lines').insert(olRows);
      createdImports++;
    }

    return NextResponse.json({
      created_imports: createdImports,
      new_lines: lines.length,
      changes_detected: result.changes.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Cron sync failed' }, { status: 502 });
  }
}
