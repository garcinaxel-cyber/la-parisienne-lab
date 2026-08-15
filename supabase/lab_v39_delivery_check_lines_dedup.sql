-- 2026-08-14 (applied live via Supabase MCP).
-- 86 duplicate rows found for REP/2026/01039 x ITEM-Y08Q (Axel) — no unique constraint existed
-- on lab_delivery_check_lines, so concurrent page loads of the category view (each re-running
-- ensureDeliveryOrderChecklist's read-then-insert with no locking) could each insert their own
-- copy. Partial unique index covers the delivery_order_id path (category page/order page);
-- manual_cake_id already assumed 1:1 in code (ensureUnreconciledChecklist) but had no DB-level
-- guarantee either — same class of bug, fixed the same way. Companion code fix in
-- src/lib/delivery-check.ts switches both insert() calls to upsert(..., { ignoreDuplicates: true }).
create unique index if not exists lab_delivery_check_lines_order_sku_uniq
  on lab_delivery_check_lines (delivery_order_id, category, sku)
  where delivery_order_id is not null;

create unique index if not exists lab_delivery_check_lines_cake_uniq
  on lab_delivery_check_lines (manual_cake_id)
  where manual_cake_id is not null;
