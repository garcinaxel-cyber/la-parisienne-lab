import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConsolidatedLine } from '@/lib/excel-parser';

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

export interface PersistOptions {
  status: 'draft' | 'published';
  type?: 'daily' | 'cake_addon';
  notes?: string;
  shippedFromLab?: boolean;
  filenameSales?: string | null;
  filenameRepl?: string | null;
  orderStates?: Record<string, string>;      // ref -> Odoo status (for badges)
  sourceTypeByRef?: Record<string, string>;   // ref -> 'sales_order' | 'replenishment'
  deliveryTimeByRef?: Record<string, string>; // manual "ready time per order" overrides
  skipped?: any[];                            // control report (lines dropped by parser)
  excluded?: any[];                           // control report (user-excluded SKUs)
  auto?: boolean;                             // true when created by the hourly cron
}

// SINGLE source of truth for turning consolidated lines into imports + production cards
// + order lines + a consistent control report. Used by BOTH the manual publish flow
// (ImportView) and the hourly auto-sync (cron), so the two never drift again.
// One import per delivery_date. Excluded SKUs must already be filtered upstream.
export async function persistImportsFromLines(
  supabase: SupabaseClient,
  consolidated: ConsolidatedLine[],
  opts: PersistOptions,
): Promise<{ createdImports: number; earliestDate: string | null; error?: string }> {
  const today = new Date().toISOString().split('T')[0];

  // Resolve every SKU → variant → fiche once (team default = fiche.teams[0])
  const skus = Array.from(new Set(consolidated.map(l => l.product_sku).filter(Boolean)));
  const { data: variantRows } = skus.length
    ? await supabase.from('lab_fiche_variants').select('id, sku, label, fiche_id, image_url').in('sku', skus)
    : { data: [] as any[] };
  const vBySku: Record<string, any> = {};
  for (const v of variantRows ?? []) if (v.sku) vBySku[v.sku] = v;
  const ficheIds = Array.from(new Set((variantRows ?? []).map(v => v.fiche_id).filter(Boolean)));
  const { data: ficheRows } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, name_en, image_url').in('id', ficheIds)
    : { data: [] as any[] };
  const fById: Record<string, any> = {};
  for (const f of ficheRows ?? []) fById[f.id] = f;

  // Group by delivery date — one import each
  const byDate = new Map<string, ConsolidatedLine[]>();
  for (const line of consolidated) {
    const date = line.delivery_date || today;
    (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(line);
  }

  const allDates = Array.from(byDate.keys()).sort();
  let createdImports = 0;

  for (const date of allDates) {
    const dateLines = byDate.get(date)!;
    const orderRefs = Array.from(new Set(dateLines.flatMap(l => l.breakdown.map((b: any) => b.order_ref)).filter(Boolean)));

    const { count } = await supabase
      .from('lab_imports').select('*', { count: 'exact', head: true }).eq('delivery_date', date);

    // Consistent control report (same shape for manual + auto)
    const controlReport = {
      totals: {
        lines: dateLines.length,
        qty: dateLines.reduce((s, l) => s + l.total_qty, 0),
        orders: orderRefs.length,
        skipped: (opts.skipped ?? []).length,
        excluded: (opts.excluded ?? []).length,
      },
      by_order: orderRefs.map(ref => {
        const bs = dateLines.flatMap(l => l.breakdown.filter((b: any) => b.order_ref === ref));
        return { order_ref: ref, lines: bs.length, qty: bs.reduce((a: number, b: any) => a + b.qty, 0) };
      }),
      by_product: dateLines.map(l => ({ sku: l.product_sku, name: l.product_name_vi, qty: l.total_qty })),
      skipped: opts.skipped ?? [],
      excluded: opts.excluded ?? [],
      order_states: opts.orderStates
        ? Object.fromEntries(orderRefs.map(r => [r, opts.orderStates![r]]).filter(([, s]) => s))
        : {},
      auto: !!opts.auto,
    };

    const { data: importRow, error: impErr } = await supabase.from('lab_imports').insert({
      delivery_date: date,
      order_number: (count ?? 0) + 1,
      type: opts.type ?? 'daily',
      shipped_from_lab: !!opts.shippedFromLab,
      notes: opts.notes ?? (opts.auto ? 'Auto-sync Odoo' : ''),
      status: opts.status,
      filename_sales: opts.filenameSales ?? (opts.auto ? 'Odoo auto-sync' : null),
      filename_repl: opts.filenameRepl ?? null,
      published_at: opts.status === 'published' ? new Date().toISOString() : null,
      control_report: controlReport,
    }).select('id').single();
    if (impErr || !importRow) return { createdImports, earliestDate: allDates[0] ?? null, error: impErr?.message };

    // Production cards — only lines whose SKU resolves to a team
    const assignable = dateLines.filter(l => TEAMS.includes(l.team));
    if (assignable.length) {
      const { error: asgErr } = await supabase.from('lab_assignments').insert(assignable.map((line, idx) => {
        const v = vBySku[line.product_sku] ?? null;
        const f = v ? fById[v.fiche_id] ?? null : null;
        return {
          import_id: importRow.id, team: line.team,
          fiche_id: v?.fiche_id ?? null, variant_id: v?.id ?? null,
          product_name_vi: line.product_name_vi, product_name_en: f?.name_en ?? '',
          image_url: v?.image_url ?? f?.image_url ?? null,
          variant_label: line.variant_label,
          total_qty: line.total_qty, qty_to_produce: line.total_qty, qty_produced: 0,
          status: 'pending', sort_order: idx, breakdown: line.breakdown ?? [],
        };
      }));
      if (asgErr) {
        await supabase.from('lab_imports').delete().eq('id', importRow.id);
        return { createdImports, earliestDate: allDates[0] ?? null, error: asgErr.message };
      }
    }

    // Raw order lines (one per breakdown entry) for traceability + per-order views
    const olRows = dateLines.flatMap(line => line.breakdown.map((b: any) => ({
      import_id: importRow.id,
      source_type: opts.sourceTypeByRef?.[b.order_ref] ?? 'sales_order',
      order_ref: b.order_ref, shop_name: b.shop_name,
      product_sku: line.product_sku, product_name_vi: line.product_name_vi,
      team: line.team, variant_label: line.variant_label, qty: b.qty,
      delivery_date: date,
      delivery_time: opts.deliveryTimeByRef?.[b.order_ref] ?? b.delivery_time ?? null,
      fiche_id: vBySku[line.product_sku]?.fiche_id ?? null,
      variant_id: vBySku[line.product_sku]?.id ?? null,
    })));
    if (olRows.length) await supabase.from('lab_order_lines').insert(olRows);
    createdImports++;
  }

  return { createdImports, earliestDate: allDates[0] ?? null };
}
