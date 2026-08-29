import type { SupabaseClient } from '@supabase/supabase-js';
import { runOdooSync } from '@/lib/odoo-sync';
import { consolidateLines } from '@/lib/excel-parser';
import { persistImportsFromLines } from '@/lib/import-persist';
import { applyOdooChanges } from '@/lib/odoo-apply';

export interface AutoSyncResult {
  created_imports: number;
  new_lines: number;
  changes_detected: number;
  changes_applied: number;
  deleted_refs: number;
  cleaned_drafts: number;
  checked?: { sales: number; replenishments: number };
  error?: string;
  skipped_concurrent?: boolean; // another sync (cron or a chef's button) was already running
  packaging_only_synced?: number;
  packaging_only_error?: string; // best-effort, never fails the main sync (see write site below)
}

// Single-row mutex (lab_sync_lock, see lab_v28_sync_lock.sql) so two overlapping calls — the
// hourly cron firing at the same moment a chef clicks "Sync Odoo", or two chefs clicking at
// once across the 4 team pages — can't both read Odoo as "not yet imported" for the same new
// order and each create their own duplicate production card. A plain UPDATE is used instead of
// a Postgres advisory lock: PostgREST calls can each land on a different pooled connection, so
// a session-scoped lock acquired on one connection could be "released" on another and do
// nothing. The 2-minute expiry self-heals if a run crashes before reaching the finally-release.
const SYNC_LOCK_ID = true;
const SYNC_LOCK_DURATION_MS = 2 * 60 * 1000;

async function acquireSyncLock(supabase: SupabaseClient): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SYNC_LOCK_DURATION_MS).toISOString();
  const { data: freeRows, error: freeErr } = await supabase
    .from('lab_sync_lock').update({ locked_until: expiresAt }).eq('id', SYNC_LOCK_ID).is('locked_until', null).select('id');
  if (freeErr) return true; // fail OPEN — a lock-table hiccup must never block sync entirely
  if (freeRows?.length) return true;
  // Nobody held a null lock — try stealing an expired one (crashed run) instead.
  const { data: staleRows, error: staleErr } = await supabase
    .from('lab_sync_lock').update({ locked_until: expiresAt }).eq('id', SYNC_LOCK_ID).lt('locked_until', nowIso).select('id');
  if (staleErr) return true;
  return !!staleRows?.length;
}

async function releaseSyncLock(supabase: SupabaseClient): Promise<void> {
  await supabase.from('lab_sync_lock').update({ locked_until: null }).eq('id', SYNC_LOCK_ID);
}

// SHARED "auto" sync: pulls Odoo, publishes new orders straight away (no manual review step),
// auto-applies modifications/cancellations, and cleans up orphaned drafts. Used by BOTH the
// hourly pg_cron job (/api/odoo/cron) and the on-demand "Sync Odoo" button on the station pages
// — same behaviour either way, just triggered on a timer vs by a chef who doesn't want to wait
// for the next cron pass. Needs a SERVICE-ROLE client (writes across tables no station RLS
// policy grants access to).
export async function runAutoOdooSync(supabase: SupabaseClient): Promise<AutoSyncResult> {
  const gotLock = await acquireSyncLock(supabase);
  if (!gotLock) {
    return {
      created_imports: 0, new_lines: 0, changes_detected: 0, changes_applied: 0,
      deleted_refs: 0, cleaned_drafts: 0, skipped_concurrent: true,
    };
  }
  try {
    return await runAutoOdooSyncLocked(supabase);
  } finally {
    await releaseSyncLock(supabase);
  }
}

async function runAutoOdooSyncLocked(supabase: SupabaseClient): Promise<AutoSyncResult> {
  const result = await runOdooSync(supabase as any);
  const lines = result.lines;

  // 100%-packaging replenishments (see OdooSyncResult.packagingOnly doc comment) — write
  // straight into lab_order_packaging_lines so they show up in delivery-check even though
  // they never get a lab_imports/lab_order_lines row. Same upsert key as odoo-packaging-sync.ts
  // so re-running this never duplicates a row.
  //
  // BUG FIX 2026-08-17 (REP/2026/01076, Axel: "cette commande de produit hors production
  // n'apparaît pas du tout"): ROOT CAUSE, reproduced directly against a throwaway temp table —
  // Postgres error 21000 "ON CONFLICT DO UPDATE command cannot affect row a second time". Odoo
  // lets the same excluded SKU appear on several lines of one order (here VTTH.713 ×2, TEM ×3 —
  // one line per note, e.g. one sticker line per cake flavor), so `result.packagingOnly` can carry
  // duplicate (order_ref, sku) pairs; upserting them in one batch with onConflict on that same
  // pair is rejected outright by Postgres, deterministically, every single sync (cron or manual
  // button) — never a fluke, and this upsert's result was never checked, so it failed silently
  // with no trace anywhere: no thrown exception (nothing in Vercel's runtime-error tracking), and
  // the coverage-check right below builds `packagingRefs` from this SAME in-memory array
  // regardless of whether the write actually landed, so it never flagged a gap either. Fixed by
  // aggregating same-SKU lines (sum qty, merge notes) before the upsert — mirrors how
  // delivery-check.ts already aggregates duplicate production SKUs on the same order.
  const packagingOnlyAgg = new Map<string, typeof result.packagingOnly[number]>();
  for (const p of result.packagingOnly) {
    const k = `${p.order_ref}||${p.sku}`;
    const cur = packagingOnlyAgg.get(k);
    if (!cur) packagingOnlyAgg.set(k, { ...p });
    else {
      cur.qty += p.qty;
      if (p.note && !cur.note?.includes(p.note)) cur.note = cur.note ? `${cur.note} / ${p.note}` : p.note;
    }
  }
  let packagingOnlySynced = 0;
  let packagingOnlyError: string | undefined;
  if (packagingOnlyAgg.size) {
    const { error: packagingOnlyErr } = await supabase.from('lab_order_packaging_lines')
      .upsert(Array.from(packagingOnlyAgg.values()).map(r => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: 'order_ref,sku' });
    if (packagingOnlyErr) packagingOnlyError = packagingOnlyErr.message;
    else packagingOnlySynced = packagingOnlyAgg.size;
  }

  // Warehouse/customer reassignment on an already-imported order (see OdooSyncResult.shopNameChanges
  // doc comment — 2026-08-11, REP/2026/01012). Auto-correct every table carrying a denormalized
  // shop_name for that ref; a ref only ever touches the tables it actually has rows in, the other
  // updates are harmless no-ops (0 rows matched).
  for (const c of result.shopNameChanges) {
    await supabase.from('lab_order_lines').update({ shop_name: c.new_shop_name }).eq('order_ref', c.order_ref);
    await supabase.from('lab_order_packaging_lines').update({ shop_name: c.new_shop_name }).eq('order_ref', c.order_ref);
    await supabase.from('lab_delivery_orders').update({ shop_name: c.new_shop_name }).eq('order_ref', c.order_ref);
  }

  // Same blind spot, for notes (see OdooSyncResult.noteChanges doc comment — 2026-08-11,
  // REP/2026/01012 BCMD14). lab_order_lines.note is the source of truth ensureDeliveryOrderChecklist
  // self-heals lab_delivery_check_lines.note FROM (delivery-check.ts) — updating it here is enough
  // for the note to reach the assistant's screen next time she opens that order's checklist.
  for (const c of result.noteChanges) {
    await supabase.from('lab_order_lines').update({ note: c.note })
      .eq('order_ref', c.order_ref).eq('product_sku', c.sku);
  }

  // Delivery-date reassignment (see OdooSyncResult.dateChanges doc comment — 2026-08-12,
  // S03188/KAFEBEAN). Flag-only, same diff-sync shape as lab_sync_gaps below — not auto-applied,
  // Axel does the actual date move by hand once alerted (splitting a shared import/card safely
  // isn't a blind column update).
  {
    const newDateRefs = new Set(result.dateChanges.map(c => c.order_ref));
    const { data: existingDateRows } = await supabase.from('lab_sync_date_alerts').select('order_ref');
    const staleDateRefs = (existingDateRows ?? []).map((r: any) => r.order_ref).filter((r: string) => !newDateRefs.has(r));
    if (staleDateRefs.length) await supabase.from('lab_sync_date_alerts').delete().in('order_ref', staleDateRefs);
    if (result.dateChanges.length) {
      await supabase.from('lab_sync_date_alerts').upsert(
        result.dateChanges.map(c => ({
          order_ref: c.order_ref, source_type: c.source_type, old_date: c.old_date, new_date: c.new_date,
          state: c.state, last_seen_at: new Date().toISOString(),
        })),
        { onConflict: 'order_ref' },
      );
    }
  }

  // Coverage check (see OdooSyncResult.syncGaps doc comment): keep lab_sync_gaps in sync with
  // this tick's findings — drop refs no longer flagged (fixed, delivered, or fell out of the
  // sync window), upsert the current set. Kept as a plain diff (not a full wipe) so
  // first_seen_at survives across ticks for a gap that persists.
  {
    const newGapRefs = new Set(result.syncGaps.map(g => g.order_ref));
    const { data: existingGapRows } = await supabase.from('lab_sync_gaps').select('order_ref');
    const staleGapRefs = (existingGapRows ?? []).map((r: any) => r.order_ref).filter((r: string) => !newGapRefs.has(r));
    if (staleGapRefs.length) await supabase.from('lab_sync_gaps').delete().in('order_ref', staleGapRefs);
    if (result.syncGaps.length) {
      await supabase.from('lab_sync_gaps')
        .upsert(result.syncGaps.map(g => ({ ...g, last_seen_at: new Date().toISOString() })), { onConflict: 'order_ref' });
    }
  }

  // AUTO-APPLY modifications & cancellations so the app always reflects Odoo (today + future).
  // applyOdooChanges adjusts quantities, creates newly-added products, and strikes through
  // cancelled orders — produced quantities are always preserved. We log them as 'applied'
  // for traceability (and clear any stale pending rows from the old review flow).
  let changesApplied = 0;
  if (result.changes.length) {
    const dateByRef: Record<string, string> = {};
    for (const l of lines) if (l.order_ref && l.delivery_date) dateByRef[l.order_ref] = l.delivery_date;
    const refs = result.changes.map(c => c.order_ref);
    await supabase.from('lab_odoo_changes').delete().in('order_ref', refs).eq('status', 'pending');
    const applyRes = await applyOdooChanges(supabase as any, result.changes);
    changesApplied = applyRes.applied.length;
    await supabase.from('lab_odoo_changes').insert(result.changes.map(c => ({
      order_ref: c.order_ref, cancelled: c.cancelled, items: c.items,
      delivery_date: dateByRef[c.order_ref] ?? null, status: 'applied',
    })));

    // A production-card write silently failing is exactly what left the Cheesy Danish /
    // Teddy Hug D14 lines with no card at all for days (2026-08-04 investigation) — nobody
    // knew until someone happened to open that date's orders page. Surface any failure here
    // as its own 'error' row so the dashboard can show it immediately instead of relying on
    // someone noticing the missing-card banner much later.
    if (applyRes.errors.length) {
      const byOrder = new Map<string, { sku: string; name?: string; reason: string }[]>();
      for (const e of applyRes.errors) {
        const arr = byOrder.get(e.order_ref) ?? [];
        arr.push({ sku: e.sku, name: e.name, reason: e.reason });
        byOrder.set(e.order_ref, arr);
      }
      await supabase.from('lab_odoo_changes').insert(Array.from(byOrder.entries()).map(([order_ref, items]) => ({
        order_ref, cancelled: false, items,
        delivery_date: dateByRef[order_ref] ?? null, status: 'error',
      })));
    }

    // lab_order_packaging_lines has NO cancellation cleanup anywhere else (confirmed 2026-08-11,
    // REP/2026/01012): applyOdooChanges only ever zeroes lab_order_lines qty + marks the
    // production card cancelled, it never touches this separate packaging table. Without this,
    // a cancelled order's packaging items (bags, boxes, stickers...) would linger in
    // delivery-check forever, orphaned from the now-gone/cancelled order they belonged to.
    const cancelledRefsThisTick = result.changes.filter(c => c.cancelled).map(c => c.order_ref);
    if (cancelledRefsThisTick.length) {
      await supabase.from('lab_order_packaging_lines').delete().in('order_ref', cancelledRefsThisTick);
    }
  }
  // Sibling gap for PURE-packaging orders (2026-08-29, REP/2026/01226 reject+recreate at a
  // corrected delivery date: the rejected original's 2 packaging rows sat forever under the wrong
  // date — see [[rep-reject-recreate-transition-diagnostic]]). These never appear in `result.changes`
  // above at all (that list is built from lab_order_lines diffs, and a pure-packaging order never
  // has a single lab_order_lines row — that's the whole reason packagingOnly/this table exist), so
  // cancelledRefsThisTick above can never catch them. odoo-sync.ts now tracks this separately as
  // packagingCancelledRefs, resolved the same way (state check on refs that dropped out of scope).
  if (result.packagingCancelledRefs.length) {
    await supabase.from('lab_order_packaging_lines').delete().in('order_ref', result.packagingCancelledRefs);
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
    return {
      created_imports: 0, new_lines: 0,
      changes_detected: result.changes.length,
      changes_applied: changesApplied,
      deleted_refs: result.deletedRefs.length, cleaned_drafts: cleanedDrafts,
      checked: { sales: result.stats.sales_orders, replenishments: result.stats.replenishments },
      packaging_only_synced: packagingOnlySynced, packaging_only_error: packagingOnlyError,
    };
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
    status: 'published', // AUTO mode: new Odoo orders are visible to the chefs immediately
    orderStates: result.stats.order_states,
    sourceTypeByRef,
    auto: true,
  });
  if (error) {
    return {
      created_imports: 0, new_lines: 0, changes_detected: result.changes.length,
      changes_applied: changesApplied, deleted_refs: result.deletedRefs.length,
      cleaned_drafts: cleanedDrafts, error,
      packaging_only_synced: packagingOnlySynced, packaging_only_error: packagingOnlyError,
    };
  }

  return {
    created_imports: createdImports,
    new_lines: lines.length,
    changes_detected: result.changes.length,
    changes_applied: changesApplied,
    deleted_refs: result.deletedRefs.length, cleaned_drafts: cleanedDrafts,
    packaging_only_synced: packagingOnlySynced, packaging_only_error: packagingOnlyError,
  };
}
