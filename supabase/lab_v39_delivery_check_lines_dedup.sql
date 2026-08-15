-- 2026-08-14 (applied live via Supabase MCP).
-- 86 duplicate rows found for REP/2026/01039 x ITEM-Y08Q (Axel) — no unique constraint existed
-- on lab_delivery_check_lines, so concurrent page loads of the category view (each re-running
-- ensureDeliveryOrderChecklist's read-then-insert with no locking) could each insert their own
-- copy. manual_cake_id already assumed 1:1 in code (ensureUnreconciledChecklist) but had no
-- DB-level guarantee either — same class of bug, fixed the same way. Companion code fix in
-- src/lib/delivery-check.ts switches both insert() calls to upsert(..., { ignoreDuplicates: true }).
--
-- CORRECTED same day (2026-08-14, ~19:41 VN): the first version of this migration used PARTIAL
-- unique indexes (WHERE delivery_order_id/manual_cake_id IS NOT NULL) to let the other row type
-- (manual-cake rows have delivery_order_id null and vice versa) coexist. That broke production
-- immediately — PostgREST's upsert(..., { onConflict }) cannot match a partial index, only a
-- plain one, so every delivery-check page load started throwing Postgres 42P10 ("no unique or
-- exclusion constraint matching the ON CONFLICT specification"). Plain (non-partial) unique
-- indexes work instead: Postgres already treats NULL as distinct from NULL in a unique index,
-- so the null-delivery_order_id / null-manual_cake_id rows never conflict with each other
-- without needing a WHERE clause at all.
create unique index if not exists lab_delivery_check_lines_order_sku_uniq
  on lab_delivery_check_lines (delivery_order_id, category, sku);

create unique index if not exists lab_delivery_check_lines_cake_uniq
  on lab_delivery_check_lines (manual_cake_id);
