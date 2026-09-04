import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConsolidatedLine } from '@/lib/excel-parser';
import { getManualCakeCoverage, excessQty } from '@/lib/manual-cake-coverage';
import { sendTeamPush } from '@/lib/push-notify';

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

  // Guard against double-import: never re-create an order that already exists in another
  // import (e.g. an hourly auto-sync draft that appeared between a manual sync's fetch and
  // its publish). We drop only those already-present order refs; brand-new orders are
  // untouched, so a normal publish behaves exactly as before.
  const allRefs = Array.from(new Set(consolidated.flatMap(l => l.breakdown.map((b: any) => b.order_ref)).filter(Boolean)));
  let alreadyRefs = new Set<string>();
  if (allRefs.length) {
    // BUG FIX 2026-08-26 (Axel: "pourquoi y a eu un doublon de fiche" — S03361/S03363/S03365/
    // S03388, and older, same cause, S02807/S02984): this used to be scoped to a 7-day lookback
    // matching odoo-sync.ts's SYNC_GRACE_DAYS, on the theory that "already imported" only needs
    // to look back as far as the sync itself does. Wrong: this checks the EXISTING row's OWN
    // (possibly long-stale) delivery_date, not how recently the sync ran. When Odoo reassigns an
    // order's date well after it was first imported, the original row keeps its ORIGINAL date
    // forever — once that's more than the lookback in the past, this stops recognizing the ref as
    // already-imported and lets a full duplicate back in. Widened to 90 days (see odoo-sync.ts's
    // matching fix for the full explanation) — bounded, not unbounded, so this doesn't scale
    // forever as the table grows, but wide enough that no realistic date-reassignment gap trips
    // it again. Still scoped to `allRefs` (this batch's own refs only), so row count stays small
    // regardless — no pagination needed here unlike the two odoo-sync.ts queries this mirrors.
    const antiDupSince = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const { data: exRows } = await supabase
      .from('lab_order_lines').select('order_ref').in('order_ref', allRefs).gte('delivery_date', antiDupSince);
    alreadyRefs = new Set((exRows ?? []).map((r: any) => r.order_ref));
  }
  const toPersist = alreadyRefs.size
    ? consolidated
        .map(l => {
          const bd = l.breakdown.filter((b: any) => !alreadyRefs.has(b.order_ref));
          return { ...l, breakdown: bd, total_qty: bd.reduce((s: number, b: any) => s + b.qty, 0) };
        })
        .filter(l => l.breakdown.length > 0)
    : consolidated;

  // Group by delivery date — one import each
  const byDate = new Map<string, ConsolidatedLine[]>();
  for (const line of toPersist) {
    const date = line.delivery_date || today;
    (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(line);
  }

  const allDates = Array.from(byDate.keys()).sort();
  let createdImports = 0;

  // Birthday cakes: a line already covered by a manual cake (same SKU + order + delivery date)
  // must NOT get its own production card — the manual cake IS the card for that demand. See
  // manual-cake-coverage.ts for the full rationale (unmatched vs matched, quantity-aware).
  // BUG FIX 2026-07-30 / 2026-08-04: an earlier version of this guard only looked at
  // needs_odoo=true (unmatched) and excluded whole SKUs, not quantities — so (a) once a cake got
  // matched, ANY later sync of that order recreated a full duplicate card, and (b) even while
  // unmatched, a real extra unit added on top of the cake's own qty had nowhere to go. Fixed by
  // trimming each line's per-order breakdown down to the excess over what manual cakes cover,
  // instead of an all-or-nothing SKU exclusion. The Odoo order line itself is always imported in
  // full below (for the record) — only the production-card portion is trimmed.

  for (const date of allDates) {
    const dateLines = byDate.get(date)!;
    const orderRefs = Array.from(new Set(dateLines.flatMap(l => l.breakdown.map((b: any) => b.order_ref)).filter(Boolean)));

    // order_number = highest existing + 1 (robust to deleted imports leaving numbering gaps;
    // count+1 could collide with a surviving import after a deletion)
    const { data: maxRow } = await supabase
      .from('lab_imports').select('order_number').eq('delivery_date', date)
      .order('order_number', { ascending: false }).limit(1).maybeSingle();
    const orderNumber = (maxRow?.order_number ?? 0) + 1;

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
      order_number: orderNumber,
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

    // Production cards — only lines whose SKU resolves to a team, trimmed down to the qty NOT
    // already covered by a manual cake (per order_ref — see manual-cake-coverage.ts).
    // ONE CARD PER SYNC BATCH — no merging across sync runs. (Merging into a same-day card was
    // tried 2026-08-01 and reverted 2026-08-03: the cross-import lookup silently failed to
    // find/update the shared card on most runs — confirmed via production data, e.g. the same
    // product getting 2-7 separate cards across a single day's cron runs, exactly the
    // fragmentation the merge was meant to prevent — and the sharing itself, when it DID work,
    // caused two further bugs: a stale `transferred` flag after reopening a merged 'done' card,
    // and applyOdooChanges finding the wrong card when an order that had merged into someone
    // else's card was later modified in Odoo. A plain 1-import-per-card model can't have either
    // bug by construction. Chefs still see one consolidated total via the Production tab's
    // "Tổng cần làm" recap (aggregates across cards), and send-to-stock is already grouped by
    // product via groupSendable() — neither depends on cards being merged in the database.
    // 2026-08-09: withholding used to be all-or-nothing per SKU+date (any pending manual cake
    // for this SKU held back every order's card, regardless of shop) — now scoped per breakdown
    // entry (order_ref+shop), via excessQty, so only the shop the pending cake actually belongs
    // to is held back. See manual-cake-coverage.ts for the full rationale and the incident this
    // fixes (Moon Flower cakes silently starving Winmart/La Paris orders of the same product).
    const coverage = await getManualCakeCoverage(supabase, date);
    const assignable = dateLines
      .filter(l => TEAMS.includes(l.team))
      .map(l => {
        let cardQty = 0;
        const cardBreakdown: any[] = [];
        for (const b of (l.breakdown ?? [])) {
          const remainder = excessQty(coverage, b.order_ref, l.product_sku, date, b.qty ?? 0, b.shop_name);
          if (remainder > 0) { cardBreakdown.push({ ...b, qty: remainder }); cardQty += remainder; }
        }
        return { ...l, total_qty: cardQty, breakdown: cardBreakdown };
      })
      .filter(l => l.total_qty > 0);
    const asgIdByKey: Record<string, string> = {}; // card key (team|variant|name) → assignment id, to stamp order lines
    if (assignable.length) {
      const { data: insertedAsgs, error: asgErr } = await supabase.from('lab_assignments').insert(assignable.map((line, idx) => {
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
      })).select('id, team, variant_label, product_name_vi');
      if (asgErr) {
        await supabase.from('lab_imports').delete().eq('id', importRow.id);
        return { createdImports, earliestDate: allDates[0] ?? null, error: asgErr.message };
      }
      for (const a of insertedAsgs ?? []) asgIdByKey[`${a.team}||${a.variant_label}||${a.product_name_vi}`] = a.id;

      // Push notification (phase 3, 2026-09-04) — only for a PUBLISHED import: a draft (manual
      // review flow, not the Odoo auto-sync which always publishes) isn't visible to chefs yet,
      // so pushing about it would ring a phone for an order the app doesn't show — worse than no
      // notification at all. Fire-and-forget: never awaited by the caller, and sendTeamPush
      // itself never throws (no VAPID keys configured yet = silent no-op), so this can never slow
      // or break the import/sync path it's attached to.
      if (opts.status === 'published') {
        const byTeam = new Map<string, number>();
        for (const a of insertedAsgs ?? []) byTeam.set(a.team, (byTeam.get(a.team) ?? 0) + 1);
        for (const [t, teamCount] of Array.from(byTeam.entries())) {
          sendTeamPush(supabase, t, {
            title: 'La Parisienne Lab',
            body: teamCount > 1 ? `${teamCount} đơn hàng mới vừa đến` : 'Có đơn hàng mới vừa đến',
            url: `/station/${t}`,
          }).catch(() => {});
        }
      }
    }

    // Raw order lines (one per breakdown entry) for traceability + per-order views.
    // A line's `published` MUST mirror its import's status: an import created directly as
    // 'published' (manual "import & publish now") releases all its orders immediately — the
    // per-order publish flow only applies to imports that start as drafts. Without this the
    // lines defaulted to false and stayed "not published" forever (hidden from the chefs).
    const linePublished = opts.status === 'published';
    const nowIso = new Date().toISOString();
    const olRows = dateLines.flatMap(line => line.breakdown.map((b: any) => ({
      import_id: importRow.id,
      source_type: opts.sourceTypeByRef?.[b.order_ref] ?? 'sales_order',
      order_ref: b.order_ref, shop_name: b.shop_name,
      product_sku: line.product_sku, product_name_vi: line.product_name_vi,
      team: line.team, variant_label: line.variant_label, qty: b.qty,
      delivery_date: date,
      note: b.note ?? null,
      delivery_time: opts.deliveryTimeByRef?.[b.order_ref] ?? b.delivery_time ?? null,
      fiche_id: vBySku[line.product_sku]?.fiche_id ?? null,
      variant_id: vBySku[line.product_sku]?.id ?? null,
      assignment_id: asgIdByKey[`${line.team}||${line.variant_label}||${line.product_name_vi}`] ?? null,
      published: linePublished,
      published_at: linePublished ? nowIso : null,
    })));
    if (olRows.length) await supabase.from('lab_order_lines').insert(olRows);
    createdImports++;
  }

  return { createdImports, earliestDate: allDates[0] ?? null };
}
