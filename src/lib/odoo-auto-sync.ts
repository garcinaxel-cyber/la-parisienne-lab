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
  if (result.packagingOnly.length) {
    await supabase.from('lab_order_packaging_lines')
      .upsert(result.packagingOnly.map(r => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: 'order_ref,sku' });
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
    };
  }

  return {
    created_imports: createdImports,
    new_lines: lines.length,
    changes_detected: result.changes.length,
    changes_applied: changesApplied,
    deleted_refs: result.deletedRefs.length, cleaned_drafts: cleanedDrafts,
  };
}
